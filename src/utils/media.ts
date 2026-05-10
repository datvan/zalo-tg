import axios from 'axios';
import { createWriteStream, mkdirSync } from 'fs';
import { readFile, unlink, writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import { gunzipSync } from 'zlib';
import puppeteer from 'puppeteer';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
import path from 'path';
import os from 'os';

const TMP_DIR = path.join(os.tmpdir(), 'zalo-tg');

/** Download a remote URL to a temp file. Returns the local file path. */
export async function downloadToTemp(url: string, fileName?: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });

  // Sanitize filename and add a unique prefix so concurrent downloads
  // with the same logical name (e.g. multiple 'photo.jpg' in a media group)
  // do not overwrite each other.
  const baseName = (fileName ?? `download_${Date.now()}`)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 128);

  const filePath = path.join(TMP_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${baseName}`);

  const resp = await axios.get<NodeJS.ReadableStream>(url, {
    responseType: 'stream',
    timeout: 30_000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZaloTGBridge/1.0)' },
  });

  await new Promise<void>((resolve, reject) => {
    const writer = createWriteStream(filePath);
    resp.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return filePath;
}

/** Remove a temp file, ignoring errors. */
export async function cleanTemp(filePath: string): Promise<void> {
  try { await unlink(filePath); } catch { /* ignore */ }
}

/**
 * Convert an audio file to M4A (AAC) using ffmpeg.
 * Returns the path to the converted file (caller must clean it up).
 */
export async function convertToM4a(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputPath = path.join(TMP_DIR, `voice_${Date.now()}.m4a`);
  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-c:a', 'aac', '-b:a', '64k', '-ar', '44100',
      '-vn', outputPath,
    ], { windowsHide: true });
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
    ff.on('error', reject);
  });
  return outputPath;
}

/** Convert Telegram video sticker/webm to MP4 so Zalo receives motion, not a still thumbnail. */
export async function convertToMp4(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputPath = path.join(TMP_DIR, `animation_${Date.now()}.mp4`);
  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-an', outputPath,
    ], { windowsHide: true });
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
    ff.on('error', reject);
  });
  return outputPath;
}

/** Render Telegram TGS/Lottie sticker to MP4 using headless Chromium + ffmpeg. */
export async function convertTgsToMp4(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const raw = await readFile(inputPath);
  const jsonText = gunzipSync(raw).toString('utf8');
  const lottieJsonPath = path.join(TMP_DIR, `sticker_${Date.now()}.json`);
  const webmPath = path.join(TMP_DIR, `sticker_${Date.now()}.webm`);
  await writeFile(lottieJsonPath, jsonText, 'utf8');

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 512, height: 512, deviceScaleFactor: 1 });
    await page.goto('about:blank');
    await page.addScriptTag({ path: require.resolve('lottie-web/build/player/lottie.min.js') });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden"><div id="anim" style="width:512px;height:512px"></div></body></html>`);
    await page.evaluate(async (animData) => {
      await new Promise<void>((resolve, reject) => {
        const anim = (window as any).lottie.loadAnimation({
          container: document.getElementById('anim'),
          renderer: 'svg',
          loop: true,
          autoplay: true,
          animationData: animData,
        });
        anim.addEventListener('DOMLoaded', () => resolve());
        anim.addEventListener('data_failed', () => reject(new Error('lottie data_failed')));
      });
    }, JSON.parse(jsonText));

    const stream = await page.screencast({ path: webmPath as `${string}.webm` });
    await new Promise(resolve => setTimeout(resolve, 3000));
    await stream.stop();
  } finally {
    await browser.close();
    await cleanTemp(lottieJsonPath);
  }

  const mp4Path = await convertToMp4(webmPath);
  await cleanTemp(webmPath);
  return mp4Path;
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv']);

/** Guess media type from filename or URL. */
export function detectMediaType(fileNameOrUrl: string): 'image' | 'video' | 'document' {
  const lower = fileNameOrUrl.toLowerCase();
  const ext   = path.extname(lower.split('?')[0] ?? '');
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/.test(lower)) return 'image';
  if (/\.(mp4|mov|avi|mkv|webm)(\?|$)/.test(lower))  return 'video';
  return 'document';
}

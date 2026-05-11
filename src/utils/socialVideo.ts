import { mkdirSync, statSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { cleanTemp } from './media.js';

const TMP_DIR = process.env.TMP || process.env.TEMP || '/tmp';
const SOCIAL_VIDEO_RE = /https?:\/\/(?:www\.|m\.|vt\.|vm\.)?(?:tiktok\.com\/\S+|youtube\.com\/\S+|youtu\.be\/\S+|facebook\.com\/(?:reel|watch|share\/r|share\/v)\/\S+|fb\.watch\/\S+)/i;
const MAX_BYTES = 50 * 1024 * 1024;
const COOLDOWN_MS = 60_000;

const lastByThread = new Map<string, number>();

export function extractSocialVideoUrl(text: string): string | undefined {
  const match = text.match(SOCIAL_VIDEO_RE);
  if (!match) return undefined;
  return match[0].replace(/[\])}>.,!?]+$/, '');
}

export function canProcessSocialVideo(threadKey: string): boolean {
  const now = Date.now();
  const last = lastByThread.get(threadKey) ?? 0;
  if (now - last < COOLDOWN_MS) return false;
  lastByThread.set(threadKey, now);
  return true;
}

export function socialVideoLabel(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('tiktok.com')) return 'TikTok';
  if (lower.includes('youtu.be') || lower.includes('youtube.com')) return 'YouTube';
  if (lower.includes('facebook.com') || lower.includes('fb.watch')) return 'Facebook Reels';
  return 'Social video';
}

async function normalizeForZalo(inputPath: string): Promise<string> {
  const outputPath = path.join(TMP_DIR, `social_zalo_${Date.now()}.mp4`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-t', '300',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-movflags', '+faststart',
      outputPath,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += String(d); });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-4000)}`)));
    p.on('error', reject);
  });
  return outputPath;
}

export async function downloadSocialVideo(url: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outTpl = path.join(TMP_DIR, `social_${Date.now()}.%(ext)s`);
  const args = [
    '-m', 'yt_dlp',
    '--no-playlist',
    '--no-warnings',
    '--max-filesize', String(MAX_BYTES),
    '-f', 'b[ext=mp4][acodec!=none][vcodec^=h264]/b[ext=mp4][acodec!=none]/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', outTpl,
    url,
  ];

  await new Promise<void>((resolve, reject) => {
    const p = spawn('python', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += String(d); });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(-4000)}`)));
    p.on('error', reject);
  });

  const rawPath = outTpl.replace('%(ext)s', 'mp4');
  let outPath: string | undefined;
  try {
    outPath = await normalizeForZalo(rawPath);
    const size = statSync(outPath).size;
    if (size > MAX_BYTES) {
      await cleanTemp(outPath);
      throw new Error(`Social video too large after normalize: ${size}`);
    }
    return outPath;
  } finally {
    await cleanTemp(rawPath);
  }
}

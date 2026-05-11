import { mkdirSync, statSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { cleanTemp } from './media.js';

const TMP_DIR = process.env.TMP || process.env.TEMP || '/tmp';
const TIKTOK_RE = /https?:\/\/(?:www\.|vt\.|vm\.|m\.)?tiktok\.com\/\S+/i;
const MAX_BYTES = 50 * 1024 * 1024;
const COOLDOWN_MS = 60_000;

const lastByThread = new Map<string, number>();

export function extractTikTokUrl(text: string): string | undefined {
  const match = text.match(TIKTOK_RE);
  if (!match) return undefined;
  return match[0].replace(/[\])}>.,!?]+$/, '');
}

export function canProcessTikTok(threadKey: string): boolean {
  const now = Date.now();
  const last = lastByThread.get(threadKey) ?? 0;
  if (now - last < COOLDOWN_MS) return false;
  lastByThread.set(threadKey, now);
  return true;
}

async function normalizeForZalo(inputPath: string): Promise<string> {
  const outputPath = path.join(TMP_DIR, `tiktok_zalo_${Date.now()}.mp4`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-movflags', '+faststart',
      outputPath,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += String(d); });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 1000)}`)));
    p.on('error', reject);
  });
  return outputPath;
}

export async function downloadTikTokVideo(url: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outTpl = path.join(TMP_DIR, `tiktok_${Date.now()}.%(ext)s`);
  const args = [
    '-m', 'yt_dlp',
    '--no-playlist',
    '--no-warnings',
    '--max-filesize', String(MAX_BYTES),
    '-f', 'bv*+ba/b[ext=mp4]/b',
    '--merge-output-format', 'mp4',
    '-o', outTpl,
    url,
  ];

  await new Promise<void>((resolve, reject) => {
    const p = spawn('python', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += String(d); });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(0, 1000)}`)));
    p.on('error', reject);
  });

  const rawPath = outTpl.replace('%(ext)s', 'mp4');
  let outPath: string | undefined;
  try {
    outPath = await normalizeForZalo(rawPath);
    const size = statSync(outPath).size;
    if (size > MAX_BYTES) {
      await cleanTemp(outPath);
      throw new Error(`TikTok video too large after normalize: ${size}`);
    }
    return outPath;
  } finally {
    await cleanTemp(rawPath);
  }
}

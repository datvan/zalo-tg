import { mkdirSync, readdirSync, statSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { cleanTemp } from './media.js';

const TMP_DIR = process.env.TMP || process.env.TEMP || '/tmp';
const SOCIAL_VIDEO_RE = /https?:\/\/(?:www\.|m\.|vt\.|vm\.)?(?:tiktok\.com\/\S+|youtube\.com\/\S+|youtu\.be\/\S+|facebook\.com\/(?:reel|watch|share\/r|share\/v)\/\S+|fb\.watch\/\S+)/i;
const MAX_BYTES = 100 * 1024 * 1024;
const TARGET_SEGMENT_BYTES = 90 * 1024 * 1024;
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

async function normalizeForZalo(inputPath: string, suffix = ''): Promise<string> {
  const outputPath = path.join(TMP_DIR, `social_zalo_${Date.now()}${suffix}.mp4`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '26', '-b:v', '0',
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

async function probeDurationSeconds(inputPath: string): Promise<number> {
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => { stdout += String(d); });
    p.stderr.on('data', d => { stderr += String(d); });
    p.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`ffprobe exit ${code}: ${stderr.slice(-1000)}`)));
    p.on('error', reject);
  });
  const duration = Number(out);
  return Number.isFinite(duration) && duration > 0 ? duration : 300;
}

async function normalizeSegmentForZalo(inputPath: string, start: number, duration: number, idx: number): Promise<string> {
  const outputPath = path.join(TMP_DIR, `social_zalo_${Date.now()}_part${idx}.mp4`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-y', '-ss', String(start), '-i', inputPath,
      '-t', String(duration),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '26', '-b:v', '0',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-movflags', '+faststart',
      outputPath,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += String(d); });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg segment exit ${code}: ${stderr.slice(-4000)}`)));
    p.on('error', reject);
  });
  return outputPath;
}

async function splitForZalo(inputPath: string, firstNormalizedPath: string): Promise<string[]> {
  const firstSize = statSync(firstNormalizedPath).size;
  if (firstSize <= MAX_BYTES) return [firstNormalizedPath];

  await cleanTemp(firstNormalizedPath);
  const duration = await probeDurationSeconds(inputPath);
  const parts = Math.ceil(firstSize / TARGET_SEGMENT_BYTES);
  const segmentDuration = Math.ceil(duration / parts);
  console.log(`[SocialVideo] Splitting ${Math.round(duration)}s video into ${parts} part(s), ${segmentDuration}s each`);
  const outputs: string[] = [];
  for (let i = 0; i < parts; i++) {
    const start = i * segmentDuration;
    if (start >= duration) break;
    const out = await normalizeSegmentForZalo(inputPath, start, Math.min(segmentDuration, duration - start), i + 1);
    const size = statSync(out).size;
    if (size > MAX_BYTES) {
      await cleanTemp(out);
      throw new Error(`Social video segment ${i + 1} too large after split: ${size}`);
    }
    outputs.push(out);
  }
  return outputs;
}

export async function downloadSocialVideo(url: string): Promise<string[]> {
  mkdirSync(TMP_DIR, { recursive: true });
  const jobId = Date.now();
  const outBase = `social_${jobId}`;
  const outTpl = path.join(TMP_DIR, `${outBase}.%(ext)s`);
  const args = [
    '-m', 'yt_dlp',
    '--no-playlist',
    '--no-warnings',
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

  const candidates = readdirSync(TMP_DIR)
    .filter(name => name.startsWith(`${outBase}.`))
    .map(name => path.join(TMP_DIR, name));
  const rawPath = candidates.sort((a, b) => statSync(b).size - statSync(a).size)[0];
  if (!rawPath) throw new Error(`yt-dlp did not create output for ${outBase}`);

  let outPath: string | undefined;
  try {
    outPath = await normalizeForZalo(rawPath);
    return await splitForZalo(rawPath, outPath);
  } finally {
    for (const candidate of candidates) await cleanTemp(candidate);
  }
}



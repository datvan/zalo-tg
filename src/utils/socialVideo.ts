import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { cleanTemp } from './media.js';
import { markError, markHealth } from '../health.js';
import { fetchText, downloadBinary } from './tiktokWebFallback.js';
import { downloadTikTokViaBrowser } from './tiktokBrowserFallback.js';
import { downloadThreadsViaBrowser } from './threadsBrowserFallback.js';
import { downloadFacebookViaBrowser } from './facebookBrowserFallback.js';
import { FB_NETSCAPE_COOKIES_PATH } from './facebookBrowserSession.js';
import { ytDlpBinPath } from './ytDlpMaintenance.js';

const TMP_DIR = process.env.TMP || process.env.TEMP || '/tmp';
// Stop at JSON/string delimiters when Zalo embeds link previews as serialized payloads.
const SOCIAL_VIDEO_RE = /https?:\/\/(?:www\.|m\.|vt\.|vm\.)?(?:tiktok\.com\/[^\s"'<>\\\]}]+|youtube\.com\/[^\s"'<>\\\]}]+|youtu\.be\/[^\s"'<>\\\]}]+|facebook\.com\/(?:reel|watch|share\/r|share\/v)\/[^\s"'<>\\\]}]+|fb\.watch\/[^\s"'<>\\\]}]+|threads\.(?:com|net)\/(?:@[^\/\s"'<>\\\]}]+\/post\/|share\/)[^\s"'<>\\\]}]+|vk\.com\/video[^\s"'<>\\\]}]+|vkvideo\.ru\/video[^\s"'<>\\\]}]+)/i;
const SOCIAL_VIDEO_RE_GLOBAL = /https?:\/\/(?:www\.|m\.|vt\.|vm\.)?(?:tiktok\.com\/[^\s"'<>\\\]}]+|youtube\.com\/[^\s"'<>\\\]}]+|youtu\.be\/[^\s"'<>\\\]}]+|facebook\.com\/(?:reel|watch|share\/r|share\/v)\/[^\s"'<>\\\]}]+|fb\.watch\/[^\s"'<>\\\]}]+|threads\.(?:com|net)\/(?:@[^\/\s"'<>\\\]}]+\/post\/|share\/)[^\s"'<>\\\]}]+|vk\.com\/video[^\s"'<>\\\]}]+|vkvideo\.ru\/video[^\s"'<>\\\]}]+)/ig;
const UNSUPPORTED_SOCIAL_POST_RE = /https?:\/\/(?:www\.|m\.)?facebook\.com\/share\/(?:p|post)\/\S+/i;
const ZALO_MAX_BYTES = Number(process.env.ZALO_VIDEO_MAX_BYTES || 90 * 1024 * 1024);
const ZALO_TARGET_SEGMENT_BYTES = Number(process.env.ZALO_VIDEO_TARGET_BYTES || 85 * 1024 * 1024);
const TELEGRAM_MAX_BYTES = Number(process.env.TELEGRAM_VIDEO_MAX_BYTES || 50 * 1024 * 1024);
const TELEGRAM_TARGET_SEGMENT_BYTES = Number(process.env.TELEGRAM_VIDEO_TARGET_BYTES || 45 * 1024 * 1024);

export function telegramPartCountForSize(size: number): number {
  return size <= TELEGRAM_MAX_BYTES ? 1 : Math.ceil(size / TELEGRAM_TARGET_SEGMENT_BYTES);
}

export function zaloPartCountForSize(size: number): number {
  return size <= ZALO_MAX_BYTES ? 1 : Math.ceil(size / ZALO_TARGET_SEGMENT_BYTES);
}

export async function prepareTelegramVideoPaths(paths: string[]): Promise<string[]> {
  return prepareVideoPaths(paths, TELEGRAM_MAX_BYTES, TELEGRAM_TARGET_SEGMENT_BYTES, 'Telegram');
}

export async function prepareZaloVideoPaths(paths: string[]): Promise<string[]> {
  return prepareVideoPaths(paths, ZALO_MAX_BYTES, ZALO_TARGET_SEGMENT_BYTES, 'Zalo');
}

async function prepareVideoPaths(paths: string[], maxBytes: number, targetBytes: number, label: string): Promise<string[]> {
  const prepared: string[] = [];
  try {
    for (const inputPath of paths) {
      const size = statSync(inputPath).size;
      if (size <= maxBytes) {
        prepared.push(inputPath);
        continue;
      }
      const duration = await probeDurationSeconds(inputPath);
      const parts = await splitVideoBySize(inputPath, duration, Math.ceil(size / targetBytes), maxBytes, label);
      prepared.push(...parts);
    }
    return prepared;
  } catch (err) {
    for (const part of new Set(prepared)) await cleanTemp(part);
    throw err;
  }
}
const MAX_QUEUE_PER_THREAD = 10;
const SOCIAL_JOB_TIMEOUT_MS = Number(process.env.SOCIAL_JOB_TIMEOUT_MS || 12 * 60 * 1000);
const SOCIAL_QUEUE_STALE_MS = Number(process.env.SOCIAL_QUEUE_STALE_MS || 15 * 60 * 1000);

let loggedYtDlpBin = false;

function getYtDlpCommand(): { command: string; argsPrefix: string[] } {
  const bin = ytDlpBinPath();
  if (!loggedYtDlpBin) {
    console.log(`[SocialVideo] Using yt-dlp binary: ${bin}`);
    loggedYtDlpBin = true;
  }
  const argsPrefix = process.env.YTDLP_ARGS_PREFIX?.trim() ? process.env.YTDLP_ARGS_PREFIX.split(',').map(s => s.trim()).filter(Boolean) : [];
  return { command: bin, argsPrefix };
}

function facebookCookiesPath(): string | undefined {
  const explicitPath = process.env.FB_COOKIES_PATH?.trim();
  if (explicitPath && existsSync(explicitPath)) return explicitPath;
  return existsSync(FB_NETSCAPE_COOKIES_PATH) ? FB_NETSCAPE_COOKIES_PATH : undefined;
}

function getYtDlpCookiesArgs(url: string): string[] {
  if (/facebook\.com|fb\.watch/i.test(url)) {
    const cookiePath = facebookCookiesPath();
    if (!cookiePath) return [];
    return ['--cookies', cookiePath];
  }
  const tiktokCookiePath = process.env.TIKTOK_COOKIES_PATH?.trim() || path.resolve(process.cwd(), 'data', 'tiktok-cookies.txt');
  if (/tiktok\.com/i.test(url) && existsSync(tiktokCookiePath)) return ['--cookies', tiktokCookiePath];
  const vkCookiePath = process.env.VK_COOKIES_PATH?.trim() || path.resolve(process.cwd(), 'data', 'vk-cookies.txt');
  if (/(^|\.)vk\.com|(^|\.)vkvideo\.ru/i.test(new URL(url).hostname) && existsSync(vkCookiePath)) return ['--cookies', vkCookiePath];
  return [];
}

function decodeTikTokEscapedUrl(value: string): string {
  return value.replace(/\\u002F/g, '/').replace(/\\u0026/g, '&');
}

async function downloadTikTokWebFallback(url: string, outPath: string): Promise<void> {
  const html = await fetchText(url);
  const matches = html.match(/https:\\u002F\\u002F[^"']+?mime_type=video_mp4[^"']*/g) ?? [];
  const decoded = [...new Set(matches.map(decodeTikTokEscapedUrl))];
  const videoUrl = decoded.find(u => u.includes('/video/tos/') && u.includes('v16-webapp.tiktok.com')) ?? decoded.find(u => u.includes('/video/tos/')) ?? decoded[0];
  if (!videoUrl) throw new Error('TikTok web fallback found no MP4 URL');
  console.warn('[SocialVideo] TikTok web fallback MP4 URL found');
  await downloadBinary(videoUrl, outPath);
}

async function resolveTikTokOembedVideoUrl(url: string): Promise<string | undefined> {
  const apiUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  const html = await new Promise<string>((resolve, reject) => {
    const p = spawn('node', ['-e', `fetch(process.argv[1]).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{console.error(e);process.exit(1)})`, apiUrl], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => { stdout += String(d); });
    p.stderr.on('data', d => { stderr += String(d); });
    p.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`TikTok oEmbed exit ${code}: ${stderr.slice(-1000)}`)));
    p.on('error', reject);
  });
  const data = JSON.parse(html) as { html?: string };
  const embedHtml = data.html ?? '';
  const id = embedHtml.match(/data-video-id="(\d+)"/i)?.[1] ?? url.match(/\/video\/(\d+)/i)?.[1];
  if (!id) return undefined;
  return `https://www.tiktok.com/player/v1/${id}`;
}


interface QueueItem<T> {
  label: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

export interface SocialVideoMeta {
  platform: string;
  uploader?: string;
  title?: string;
  sourceUrl?: string;
  durationSeconds?: number;
  sizeBytes?: number;
}

export interface SocialVideoDownloadResult {
  paths: string[];
  meta: SocialVideoMeta;
}

const queues = new Map<string, QueueItem<unknown>[]>();
const dedupKeys = new Map<string, number>();
const DEDUP_TTL_MS = 30 * 60 * 1000;
let globalRunning = false;
let currentJobStartedAtMs = 0;
let currentJobLabel: string | undefined;

const UPLOAD_ATTACHMENT_TIMEOUT_MS = Number(process.env.ZALO_UPLOAD_ATTACHMENT_TIMEOUT_MS || 120_000);

/**
 * zca-js's uploadAttachment() has no built-in timeout: a stalled Zalo CDN connection
 * (observed as `fetch failed` / `UND_ERR_SOCKET other side closed`) can hang the call
 * indefinitely, wedging the social-video queue and eventually the whole process. Every
 * uploadAttachment() call site should go through this so a stuck upload fails fast into
 * its caller's existing fallback/retry path instead of hanging.
 */
export function withUploadTimeout<T>(promise: Promise<T>, label: string, timeoutMs = UPLOAD_ATTACHMENT_TIMEOUT_MS): Promise<T> {
  return withTimeout(promise, timeoutMs, label);
}

export async function withUploadRetry<T>(
  upload: () => Promise<T>,
  label: string,
  attempts = 3,
  retryDelayMs = 2000,
  timeoutMs = UPLOAD_ATTACHMENT_TIMEOUT_MS,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withUploadTimeout(upload(), label, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts) break;
      const delayMs = retryDelayMs * attempt;
      console.warn(`[SocialVideo] ${label} failed (${attempt}/${attempts}), retrying in ${delayMs}ms:`, err);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Social video job timeout after ${Math.round(timeoutMs / 1000)}s: ${label}`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

setInterval(() => {
  if (!globalRunning || !currentJobStartedAtMs) return;
  const age = Date.now() - currentJobStartedAtMs;
  if (age <= SOCIAL_QUEUE_STALE_MS) return;
  const label = currentJobLabel ?? 'unknown';
  const err = new Error(`Social video queue stale after ${Math.round(age / 1000)}s: ${label}`);
  console.error('[SocialVideo][Queue] STALE', err.message);
  markError(err);
  // The per-job timeout should release the queue. This interval is an external health signal
  // for the supervisor/watchdog so a wedged event loop or native child process is not silent.
}, 60_000).unref();

export function extractSocialVideoUrl(text: string): string | undefined {
  return extractSocialVideoUrls(text)[0];
}

export function extractSocialVideoUrls(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(SOCIAL_VIDEO_RE_GLOBAL)) {
    const url = match[0].replace(/[\])}>.,!?'\"]+$/, '');
    // TikTok photo posts are not videos. yt-dlp currently returns "Unsupported URL" for
    // /@user/photo/<id>, so do not enqueue them into the social-video repost pipeline.
    // The original message/link will still be bridged as plain text.
    if (/tiktok\.com\/[^\s]+\/photo\/\d+/i.test(url)) continue;
    const key = canonicalSocialVideoKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return urls;
}



export function extractUnsupportedSocialPostUrl(text: string): { url: string; reason: string } | undefined {
  const match = text.match(SOCIAL_VIDEO_RE);
  if (!match) {
    const unsupportedMatch = text.match(UNSUPPORTED_SOCIAL_POST_RE);
    if (!unsupportedMatch) return undefined;
    const unsupportedUrl = unsupportedMatch[0].replace(/[\])}>.,!?]+$/, '');
    return { url: unsupportedUrl, reason: 'Link này là Facebook post, không phải video nên bridge không tự tải/repost dạng video.' };
  }
  const url = match[0].replace(/[\])}>.,!?]+$/, '');
  if (/tiktok\.com\/[^\s]+\/photo\/\d+/i.test(url)) {
    return { url, reason: 'Link này là TikTok photo post, không phải video nên bridge chưa hỗ trợ tải/upload tự động.' };
  }
  return undefined;
}
export function canonicalSocialVideoKey(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./i, '').toLowerCase();
    if (host.includes('tiktok.com')) {
      const videoMatch = u.pathname.match(/\/video\/(\d+)/i);
      if (videoMatch) return `tiktok:video:${videoMatch[1]}`;
      const shortCode = u.pathname.split('/').filter(Boolean)[0];
      return `tiktok:short:${shortCode || url}`;
    }
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      const id = host.includes('youtu.be') ? u.pathname.split('/').filter(Boolean)[0] : (u.searchParams.get('v') ?? u.pathname.split('/').filter(Boolean).pop());
      return `youtube:${id || url}`;
    }
    if (host.includes('threads.com') || host.includes('threads.net')) {
      const shortcode = u.pathname.match(/\/post\/([^/?#]+)/i)?.[1] ?? u.pathname.split('/').filter(Boolean).pop();
      return `threads:${shortcode || url}`;
    }
    if (host.includes('facebook.com') || host.includes('fb.watch')) {
      const parts = u.pathname.split('/').filter(Boolean);
      const id = parts.find(part => /^\d{8,}$/.test(part)) ?? parts.join('/');
      return `facebook:${id || url}`;
    }
    if (host.includes('vk.com') || host.includes('vkvideo.ru')) {
      const m = u.pathname.match(/video(-?\d+_\d+)/i) ?? url.match(/video(-?\d+_\d+)/i);
      return `vk:${m?.[1] || u.pathname || url}`;
    }
  } catch { /* keep raw fallback */ }
  return url.toLowerCase().replace(/[?#].*$/, '');
}

function pumpQueues(): void {
  if (globalRunning) return;
  const entry = [...queues.entries()].find(([, q]) => q.length > 0);
  if (!entry) return;
  const [threadKey, queue] = entry;
  const item = queue.shift()!;
  if (queue.length === 0) queues.delete(threadKey);
  globalRunning = true;
  currentJobStartedAtMs = Date.now();
  currentJobLabel = item.label;
  const remaining = [...queues.values()].reduce((sum, q) => sum + q.length, 0);
  markHealth({ queueRunning: true, queueLength: remaining, currentJob: item.label, currentJobStartedAt: new Date(currentJobStartedAtMs).toISOString() });
  console.log(`[SocialVideo][Queue] START label=${item.label} thread=${threadKey} remaining=${remaining}`);
  withTimeout(item.run(), SOCIAL_JOB_TIMEOUT_MS, item.label)
    .then(item.resolve)
    .catch(err => { console.error(`[SocialVideo][Queue] FAIL label=${item.label}:`, err); markError(err); item.reject(err); })
    .finally(() => {
      globalRunning = false;
      currentJobStartedAtMs = 0;
      currentJobLabel = undefined;
      const nextLength = [...queues.values()].reduce((sum, q) => sum + q.length, 0);
      markHealth({ status: 'ok', queueRunning: false, queueLength: nextLength, currentJob: undefined, currentJobStartedAt: undefined });
      pumpQueues();
    });
}

export function enqueueSocialVideo<T>(threadKey: string, label: string, run: () => Promise<T>, dedupKey?: string): Promise<T | undefined> {
  const now = Date.now();
  for (const [key, ts] of dedupKeys) {
    if (now - ts > DEDUP_TTL_MS) dedupKeys.delete(key);
  }
  const scopedDedupKey = dedupKey ? `${threadKey}:${dedupKey}` : undefined;
  if (scopedDedupKey && dedupKeys.has(scopedDedupKey)) {
    console.log(`[SocialVideo][Queue] SKIP duplicate label=${label} thread=${threadKey} key=${dedupKey}`);
    return Promise.resolve(undefined);
  }
  if (scopedDedupKey) dedupKeys.set(scopedDedupKey, now);

  const queue = queues.get(threadKey) ?? [];
  if (queue.length >= MAX_QUEUE_PER_THREAD) {
    if (scopedDedupKey) dedupKeys.delete(scopedDedupKey);
    return Promise.reject(new Error(`Social video queue full for ${threadKey}`));
  }
  queues.set(threadKey, queue);
  const position = queue.length + (globalRunning ? 1 : 0) + 1;
  markHealth({ queueLength: queue.length + 1 + (globalRunning ? 1 : 0) });
  console.log(`[SocialVideo][Queue] QUEUED label=${label} thread=${threadKey} position=${position}${dedupKey ? ` key=${dedupKey}` : ''}`);
  return new Promise<T | undefined>((resolve, reject) => {
    queue.push({
      label,
      run: run as () => Promise<unknown>,
      // Both resolve and reject must clear the dedup key: it exists to collapse duplicate
      // *concurrent* requests (e.g. the same link posted twice within DEDUP_TTL_MS), not to
      // outlive a single completed attempt. The durable queue's retry-without-throwing path
      // (scheduleRetry) resolves this promise normally on a retryable failure — leaving the
      // key in place after resolve silently dropped every subsequent retry as a "duplicate"
      // until the 30-minute TTL expired, stalling the job indefinitely.
      resolve: ((value: unknown) => {
        if (scopedDedupKey) dedupKeys.delete(scopedDedupKey);
        resolve(value as T | undefined);
      }) as (value: unknown) => void,
      reject: (err: unknown) => {
        if (scopedDedupKey) dedupKeys.delete(scopedDedupKey);
        reject(err);
      },
    });
    pumpQueues();
  });
}

export function socialVideoLabel(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('tiktok.com')) return 'TikTok';
  if (lower.includes('youtu.be') || lower.includes('youtube.com')) return 'YouTube';
  if (lower.includes('facebook.com') || lower.includes('fb.watch')) return 'Facebook Reels';
  if (lower.includes('threads.com') || lower.includes('threads.net')) return 'Threads';
  if (lower.includes('vk.com') || lower.includes('vkvideo.ru')) return 'VK Video';
  return 'Social video';
}

async function hasVideoStream(inputPath: string): Promise<boolean> {
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => { stdout += String(d); });
    p.stderr.on('data', d => { stderr += String(d); });
    p.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`ffprobe stream exit ${code}: ${stderr.slice(-1000)}`)));
    p.on('error', reject);
  });
  return out.includes('video');
}


async function hasAudioStream(inputPath: string): Promise<boolean> {
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => { stdout += String(d); });
    p.stderr.on('data', d => { stderr += String(d); });
    p.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`ffprobe audio exit ${code}: ${stderr.slice(-1000)}`)));
    p.on('error', reject);
  });
  return out.includes('audio');
}

/**
 * Narrow, explicit, operator-invoked escape hatch for a specific known-silent-at-source
 * video (confirmed via yt-dlp + DASH manifest scan + browser network sniffing that
 * Facebook/TikTok/etc. never serves an audio track for it at all — not a download bug).
 * Scoped by canonical key via env var so it never silently weakens the general
 * anti-silent-video guard for anything else. Meant to be set only for the duration of
 * manually clearing one specific stuck job, then unset.
 */
function isSilentUploadAllowed(url: string): boolean {
  const allowed = (process.env.SOCIAL_VIDEO_ALLOW_SILENT_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(canonicalSocialVideoKey(url));
}

async function normalizeForZalo(inputPath: string, suffix = '', allowSilent = false): Promise<string> {
  if (!(await hasVideoStream(inputPath))) throw new Error(`Downloaded social media has no video stream: ${inputPath}`);
  if (!allowSilent && !(await hasAudioStream(inputPath))) throw new Error(`Downloaded social media has no audio stream; refusing to upload silent video: ${inputPath}`);
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

export async function createSocialVideoThumbnail(inputPath: string): Promise<string> {
  const outputPath = path.join(TMP_DIR, `social_thumb_${Date.now()}.jpg`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-y', '-ss', '0.5', '-i', inputPath,
      '-frames:v', '1',
      '-vf', 'scale=480:-2',
      '-q:v', '4',
      outputPath,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += String(d); });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg thumbnail exit ${code}: ${stderr.slice(-1000)}`)));
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
  if (!(await hasAudioStream(inputPath))) throw new Error(`Downloaded social media has no audio stream; refusing to split/upload silent video: ${inputPath}`);
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

async function splitVideoBySize(
  inputPath: string,
  duration: number,
  initialParts: number,
  maxBytes: number,
  label: string,
): Promise<string[]> {
  let parts = Math.max(2, initialParts);
  for (let attempt = 0; attempt < 8; attempt++) {
    const outputs: string[] = [];
    let largestSize = 0;
    const segmentDuration = Math.ceil(duration / parts);
    try {
      for (let i = 0; i < parts; i++) {
        const start = i * segmentDuration;
        if (start >= duration) break;
        const out = await normalizeSegmentForZalo(inputPath, start, Math.min(segmentDuration, duration - start), attempt * parts + i + 1);
        const size = statSync(out).size;
        largestSize = Math.max(largestSize, size);
        outputs.push(out);
        if (size > maxBytes) break;
      }
      if (largestSize <= maxBytes && outputs.length > 0) return outputs;
    } catch (err) {
      for (const output of outputs) await cleanTemp(output);
      throw err;
    }
    for (const output of outputs) await cleanTemp(output);
    parts = Math.max(parts + 1, Math.ceil(parts * Math.max(1.5, largestSize / maxBytes) * 1.1));
    console.warn(`[SocialVideo] ${label} split attempt ${attempt + 1} exceeded ${maxBytes} bytes; retrying with ${parts} part(s)`);
  }
  throw new Error(`${label} video could not be split into parts below ${maxBytes} bytes`);
}

async function splitForZalo(inputPath: string, firstNormalizedPath: string): Promise<string[]> {
  const firstSize = statSync(firstNormalizedPath).size;
  if (firstSize <= ZALO_MAX_BYTES) return [firstNormalizedPath];

  await cleanTemp(firstNormalizedPath);
  const duration = await probeDurationSeconds(inputPath);
  const parts = await splitVideoBySize(inputPath, duration, zaloPartCountForSize(firstSize), ZALO_MAX_BYTES, 'Zalo');
  console.log(`[SocialVideo] Split ${Math.round(duration)}s video into ${parts.length} part(s)`);
  return parts;
}

function cleanMetaText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 160) : undefined;
}

function cleanTitleText(value: unknown): string | undefined {
  const cleaned = cleanMetaText(value);
  if (!cleaned || /^video$/i.test(cleaned)) return undefined;
  return cleaned;
}


function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractAttr(html: string, name: string): string | undefined {
  const m = html.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'));
  return m ? decodeHtmlEntities(m[1]) : undefined;
}

async function downloadThreadsViaSnapSave(url: string, outPath: string): Promise<void> {
  const base = 'https://snapsave.vn/';
  const headers: Record<string, string> = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'vi,en-US;q=0.9,en;q=0.8',
  };
  const home = await fetch(base, { headers, redirect: 'follow' });
  const homeText = await home.text();
  const token = homeText.match(/name=["']_token["']\s+value=["']([^"']+)["']/i)?.[1]
    || homeText.match(/value=["']([^"']+)["']\s+name=["']_token["']/i)?.[1];
  if (!token) throw new Error('SnapSave token not found');
  const cookie = home.headers.get('set-cookie')?.split(',').map(x => x.split(';')[0]).join('; ');
  const postHeaders: Record<string, string> = {
    ...headers,
    'accept': 'application/json, text/javascript, */*; q=0.01',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'origin': 'https://snapsave.vn',
    'referer': base,
    'x-requested-with': 'XMLHttpRequest',
  };
  if (cookie) postHeaders.cookie = cookie;
  const body = new URLSearchParams({ _token: token, platform: 'threads', url });
  const fetchRes = await fetch('https://snapsave.vn/fetch', { method: 'POST', headers: postHeaders, body });
  const fetchTextRes = await fetchRes.text();
  if (!fetchRes.ok) throw new Error(`SnapSave fetch HTTP ${fetchRes.status}: ${fetchTextRes.slice(0, 240)}`);
  let json: any;
  try { json = JSON.parse(fetchTextRes); } catch { throw new Error(`SnapSave fetch non-JSON: ${fetchTextRes.slice(0, 240)}`); }
  if (!json?.status) throw new Error(`SnapSave fetch failed: ${String(json?.message || fetchTextRes).slice(0, 240)}`);
  const resultHtml = String(json.data || json.html || json.result || '');
  const videoFormMatch = resultHtml.match(/<form[^>]+name=["']media-download-[^"']+["'][\s\S]*?<\/form>/i);
  const videoForm = videoFormMatch?.[0];
  if (!videoForm) throw new Error('SnapSave media-download form not found');
  const mediaToken = extractAttr(videoForm.match(/name=["']_token["'][^>]*>/i)?.[0] || '', 'value') || token;
  const username = extractAttr(videoForm.match(/name=["']username["'][^>]*>/i)?.[0] || '', 'value') || '';
  const actionType = extractAttr(videoForm.match(/name=["']action_type["'][^>]*>/i)?.[0] || '', 'value') || 'download';
  const selectMatch = videoForm.match(/<select[^>]+name=["']url["'][\s\S]*?<\/select>/i)?.[0] || videoForm;
  const encryptedUrl = extractAttr(selectMatch.match(/<option[^>]+value=["'][^"']+["'][^>]*>/i)?.[0] || '', 'value');
  if (!encryptedUrl) throw new Error('SnapSave encrypted media URL not found');
  const mediaBody = new URLSearchParams({ _token: mediaToken, username, action_type: actionType, url: encryptedUrl });
  const mediaRes = await fetch('https://snapsave.vn/media-download', { method: 'POST', headers: postHeaders, body: mediaBody, redirect: 'follow' });
  if (!mediaRes.ok) {
    const errText = await mediaRes.text().catch(() => '');
    throw new Error(`SnapSave media-download HTTP ${mediaRes.status}: ${errText.slice(0, 240)}`);
  }
  const buf = Buffer.from(await mediaRes.arrayBuffer());
  if (buf.length < 1024 * 32) throw new Error(`SnapSave media-download too small: ${buf.length}`);
  writeFileSync(outPath, buf);
  console.warn(`[SocialVideo] SnapSave Threads fallback downloaded bytes=${buf.length}`);
}

async function downloadTikTokViaTikwm(url: string, outPath: string): Promise<void> {
  const api = `https://tikwm.com/api/?url=${encodeURIComponent(url)}`;
  const text = await new Promise<string>((resolve, reject) => {
    const p = spawn('node', ['-e', `fetch(process.argv[1],{headers:{'user-agent':'Mozilla/5.0','accept':'application/json'}}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{console.error(e);process.exit(1)})`, api], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', d => { stdout += String(d); });
    p.stderr.on('data', d => { stderr += String(d); });
    p.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`TikWM API exit ${code}: ${stderr.slice(-500)}`)));
    p.on('error', reject);
  });
  const j = JSON.parse(text) as Record<string, any>;
  if (Number(j.code) !== 0 || !j.data) throw new Error(`TikWM API failed code=${j.code} msg=${j.msg || j.message || ''}`);
  const d = j.data as Record<string, any>;
  const candidates = [d.play, d.wmplay, d.hdplay, d.download, d.play_addr?.url_list?.[0], d.video?.play_addr?.url_list?.[0]].filter((x: any) => typeof x === 'string' && /^https?:\/\//.test(x));
  const picked = candidates[0];
  if (!picked) throw new Error('TikWM API returned no MP4 URL');
  console.warn(`[SocialVideo] TikWM fallback URL found id=${d.id || ''} duration=${d.duration || ''} title=${String(d.title || '').slice(0,80)}`);
  await downloadBinary(picked, outPath);
}

async function downloadTikTokDirectFromExistingInfo(infoPath: string, outPath: string): Promise<void> {
  const data = JSON.parse(readFileSync(infoPath, 'utf8')) as Record<string, any>;
  const formats = Array.isArray(data.formats) ? data.formats : [];
  const candidates = formats
    .filter((f: any) => String(f.url || '').startsWith('http') && String(f.ext || '').includes('mp4'))
    .sort((a: any, b: any) => {
      const ah = /^h264/i.test(String(a.vcodec || '')) ? 1 : 0;
      const bh = /^h264/i.test(String(b.vcodec || '')) ? 1 : 0;
      if (ah !== bh) return bh - ah;
      return Number(b.filesize || b.filesize_approx || b.tbr || 0) - Number(a.filesize || a.filesize_approx || a.tbr || 0);
    });
  const picked = candidates[0];
  if (!picked?.url) throw new Error('TikTok existing info fallback found no media URL');
  console.warn(`[SocialVideo] TikTok existing-info fallback URL found format=${picked.format_id || ''} codec=${picked.vcodec || ''} size=${picked.filesize || picked.filesize_approx || ''}`);
  await downloadBinary(String(picked.url), outPath);
}

async function downloadTikTokDirectFromInfo(url: string, outPath: string): Promise<void> {
  const { command, argsPrefix } = getYtDlpCommand();
  const args = [...argsPrefix, ...getYtDlpCookiesArgs(url), '--dump-single-json', '--no-playlist', '--no-warnings', '--skip-download', url];
  const json = await new Promise<string>((resolve, reject) => {
    const p = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', d => { stdout += String(d); });
    p.stderr.on('data', d => { stderr += String(d); });
    p.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`TikTok info direct exit ${code}: ${stderr.slice(-1000)}`)));
    p.on('error', reject);
  });
  const data = JSON.parse(json) as Record<string, any>;
  const formats = Array.isArray(data.formats) ? data.formats : [];
  const candidates = formats
    .filter((f: any) => String(f.url || '').startsWith('http') && String(f.ext || '').includes('mp4'))
    .sort((a: any, b: any) => Number(b.filesize || b.filesize_approx || b.tbr || 0) - Number(a.filesize || a.filesize_approx || a.tbr || 0));
  const picked = candidates.find((f: any) => /^h264/i.test(String(f.vcodec || ''))) || candidates[0];
  if (!picked?.url) throw new Error('TikTok info direct fallback found no media URL');
  console.warn(`[SocialVideo] TikTok direct-info fallback URL found format=${picked.format_id || ''} size=${picked.filesize || picked.filesize_approx || ''}`);
  await downloadBinary(String(picked.url), outPath);
}

async function fetchSocialVideoMeta(url: string): Promise<SocialVideoMeta> {
  const platform = socialVideoLabel(url);
  try {
    const { command, argsPrefix } = getYtDlpCommand();
    const args = [
      ...argsPrefix,
      ...getYtDlpCookiesArgs(url),
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--skip-download',
      url,
    ];
    const json = await new Promise<string>((resolve, reject) => {
      const p = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', d => { stdout += String(d); });
      p.stderr.on('data', d => { stderr += String(d); });
      p.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`yt-dlp metadata exit ${code}: ${stderr.slice(-1000)}`)));
      p.on('error', reject);
    });
    const data = JSON.parse(json) as Record<string, unknown>;
    return {
      platform,
      uploader: cleanMetaText(data.uploader) ?? cleanMetaText(data.channel) ?? cleanMetaText(data.creator) ?? cleanMetaText(data.uploader_id),
      title: cleanTitleText(data.title) ?? cleanTitleText(data.fulltitle) ?? cleanMetaText(data.description),
    };
  } catch (err) {
    console.warn('[SocialVideo] Metadata fetch failed:', err);
    return { platform };
  }
}

function formatDuration(seconds?: number): string | undefined {
  if (!Number.isFinite(seconds) || !seconds || seconds <= 0) return undefined;
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatSize(bytes?: number): string | undefined {
  if (!Number.isFinite(bytes) || !bytes || bytes <= 0) return undefined;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

function formatSharer(uploader?: string): string | undefined {
  const clean = cleanMetaText(uploader);
  if (!clean) return undefined;
  if (clean.startsWith('@')) return clean;
  if (/^[A-Za-z0-9._-]{2,64}$/.test(clean)) return `@${clean}`;
  return clean;
}

export function formatSocialVideoCaption(meta: SocialVideoMeta, partLabel?: string): string {
  const title = cleanTitleText(meta.title) ?? 'Video';
  const platform = cleanMetaText(meta.platform);
  const headingBase = platform ? `${title} - ${platform}` : title;
  const lines = [
    `📘 ${partLabel ? `[${partLabel}] ` : ''}${headingBase}`,
    formatDuration(meta.durationSeconds) ? `⏱️ ${formatDuration(meta.durationSeconds)}` : undefined,
    formatSize(meta.sizeBytes) ? `💾 ${formatSize(meta.sizeBytes)}` : undefined,
    meta.sourceUrl ? `🔗 ${meta.sourceUrl}` : undefined,
    formatSharer(meta.uploader) ? `👤 Chia sẻ bởi: ${formatSharer(meta.uploader)}` : undefined,
  ].filter(Boolean) as string[];
  return lines.join('\n').slice(0, 1000);
}

function metaFromInfoJson(data: Record<string, unknown>, platform: string): SocialVideoMeta {
  return {
    platform,
    uploader: cleanMetaText(data.uploader) ?? cleanMetaText(data.channel) ?? cleanMetaText(data.creator) ?? cleanMetaText(data.uploader_id),
    title: cleanTitleText(data.title) ?? cleanTitleText(data.fulltitle) ?? cleanMetaText(data.description),
  };
}

export async function downloadSocialVideo(url: string): Promise<SocialVideoDownloadResult> {
  mkdirSync(TMP_DIR, { recursive: true });
  const jobId = Date.now();
  const outBase = `social_${jobId}`;
  const outTpl = path.join(TMP_DIR, `${outBase}.%(ext)s`);
  const { command, argsPrefix } = getYtDlpCommand();
  const commonArgs = [
    ...argsPrefix,
    ...getYtDlpCookiesArgs(url),
    '--no-playlist',
    '--no-warnings',
    '--merge-output-format', 'mp4',
    '--write-info-json',
    '-o', outTpl,
  ];
  const isFacebook = /facebook\.com|fb\.watch/i.test(url);
  const isThreads = /threads\.(?:com|net)/i.test(url);
  const formats = isFacebook ? [
    // Facebook Reels often exposes DASH as video-only AV1 + separate m4a audio.
    // Force muxed video+audio first; avoid sd/hd "unknown" progressive picks that can become silent.
    'bv*[vcodec!=none][height<=1280][ext=mp4]+ba[acodec!=none][ext=m4a]/bv*[vcodec!=none]+ba[acodec!=none]',
    'bv*[vcodec!=none]+ba[acodec!=none]',
    'b[vcodec!=none][acodec!=none][ext=mp4]/best[vcodec!=none][acodec!=none]',
  ] : [
    // TikTok sometimes labels HEVC/bytevc1 formats as AAC but downloads video-only.
    // Prefer progressive H264 MP4 with real audio first; only then try muxed/fallback formats.
    'b[vcodec^=h264][acodec!=none][height<=720][ext=mp4]/b[vcodec^=h264][acodec!=none][ext=mp4]/b[acodec!=none][ext=mp4]',
    'b[vcodec!=none][acodec!=none][ext=mp4]/best[vcodec!=none][acodec!=none]',
    'bv*[vcodec!=none][ext=mp4]+ba[acodec!=none]/bv*[vcodec!=none]+ba[acodec!=none]',
    'bestvideo[vcodec!=none]+bestaudio/best',
  ];
  const tryDownload = (targetUrl: string, format: string, attempt: number) => new Promise<void>((resolve, reject) => {
    console.log(`[SocialVideo][Download] yt-dlp start url=${targetUrl} attempt=${attempt} format=${format}`);
    const attemptTpl = path.join(TMP_DIR, `${outBase}.f${attempt}.%(ext)s`);
    const p = spawn(command, [...commonArgs.filter((v, i, a) => !(v === '-o' || a[i-1] === '-o')), '-o', attemptTpl, '-f', format, targetUrl], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += String(d); });
    p.on('close', code => { if(code===0){ console.log(`[SocialVideo][Download] yt-dlp OK url=${targetUrl} format=${format}`); resolve(); } else { console.error(`[SocialVideo][Download] yt-dlp FAIL code=${code} url=${targetUrl} format=${format} stderr=${stderr.slice(-1000)}`); reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(-4000)}`)); } });
    p.on('error', reject);
  });

  let rawPath: string | undefined;
  let downloadErr: unknown;
  let ytdlpHadUsableAv = false;
  const rounds = /tiktok\.com/i.test(url) ? 4 : 1;
  outer: for (let round = 0; round < rounds; round++) {
    if (round > 0) {
      const delayMs = 1500 + round * 1000;
      console.warn(`[SocialVideo] TikTok retry round ${round + 1}/${rounds} after no audio+video; delay=${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
    for (const [fmtIndex, format] of formats.entries()) {
      const attempt = round * formats.length + fmtIndex;
      try {
        await tryDownload(url, format, attempt);
        const nowCandidates = readdirSync(TMP_DIR).filter(name => name.startsWith(`${outBase}.f${attempt}.`)).map(name => path.join(TMP_DIR, name));
        for (const candidate of nowCandidates.filter(x => x.toLowerCase().endsWith('.mp4')).sort((a,b)=>statSync(b).size-statSync(a).size)) {
          const hasVideo = await hasVideoStream(candidate);
          const hasAudio = await hasAudioStream(candidate);
          console.log(`[SocialVideo][Download] post-format candidate=${candidate} video=${hasVideo} audio=${hasAudio}`);
          if (hasVideo && hasAudio) { rawPath = candidate; ytdlpHadUsableAv = true; downloadErr = undefined; break outer; }
        }
        downloadErr = undefined;
        console.warn(`[SocialVideo] yt-dlp format produced no audio+video; trying next format: ${format}`);
      } catch (err) {
        downloadErr = err;
        console.warn(`[SocialVideo] yt-dlp format failed, retrying if possible: ${format}`, err);
      }
    }
  }
  if (downloadErr && !rawPath) {
    const fallbackPath = path.join(TMP_DIR, `${outBase}.mp4`);
    if (isFacebook) {
      console.warn('[SocialVideo] Facebook yt-dlp failed; retrying browser/network fallback');
      await downloadFacebookViaBrowser(url, fallbackPath);
    } else if (isThreads) {
      console.warn('[SocialVideo] Threads yt-dlp unsupported/failed; retrying browser MP4 fallback');
      await downloadThreadsViaBrowser(url, fallbackPath);
    } else {
      if (!/tiktok\.com/i.test(url)) throw downloadErr;
      console.warn(`[SocialVideo] TikTok yt-dlp failed (${String(downloadErr).slice(0, 240)}); continuing to TikTok fallback chain`);
      try {
        await downloadTikTokViaBrowser(url, fallbackPath);
        const hasVideo = await hasVideoStream(fallbackPath);
        const hasAudio = await hasAudioStream(fallbackPath);
        console.log(`[SocialVideo][Download] initialBrowserFallback=${fallbackPath} video=${hasVideo} audio=${hasAudio}`);
        if (hasVideo && hasAudio) rawPath = fallbackPath;
      } catch (err) {
        console.warn('[SocialVideo] initial TikTok browser fallback failed:', err);
      }
    }
  }

  const candidates = readdirSync(TMP_DIR)
    .filter(name => name.startsWith(`${outBase}.`))
    .map(name => path.join(TMP_DIR, name));
  const mediaCandidates = candidates.filter(name => !name.endsWith('.info.json'));
  const infoPath = candidates.find(name => name.endsWith('.info.json'));
  const sortedMediaCandidates = mediaCandidates.sort((a, b) => statSync(b).size - statSync(a).size);
  const allowSilent = isSilentUploadAllowed(url);
  if (!rawPath) for (const candidate of sortedMediaCandidates) {
    const hasVideo = await hasVideoStream(candidate);
    const hasAudio = await hasAudioStream(candidate);
    console.log(`[SocialVideo][Download] fallback candidate=${candidate} video=${hasVideo} audio=${hasAudio}${allowSilent ? ' (silent upload allowed for this key)' : ''}`);
    if (hasVideo && (hasAudio || allowSilent)) {
      rawPath = candidate;
      break;
    }
  }
  if (!rawPath && /tiktok\.com/i.test(url) && infoPath) {
    const directExistingPath = path.join(TMP_DIR, `${outBase}.direct-existing.mp4`);
    console.warn('[SocialVideo] yt-dlp output had no audio+video; retrying TikTok existing info-json direct URL fallback');
    try {
      await downloadTikTokDirectFromExistingInfo(infoPath, directExistingPath);
      candidates.push(directExistingPath);
      const hasVideo = await hasVideoStream(directExistingPath);
      const hasAudio = await hasAudioStream(directExistingPath);
      console.log(`[SocialVideo][Download] directExisting=${directExistingPath} video=${hasVideo} audio=${hasAudio}`);
      if (hasVideo && hasAudio) rawPath = directExistingPath;
    } catch (err) {
      console.warn('[SocialVideo] TikTok existing-info fallback failed:', err);
    }
  }
  if (!rawPath && /tiktok\.com/i.test(url)) {
    const directPath = path.join(TMP_DIR, `${outBase}.direct.mp4`);
    console.warn('[SocialVideo] retrying TikTok direct-info fallback via fresh extractor');
    try {
      await downloadTikTokDirectFromInfo(url, directPath);
      candidates.push(directPath);
      const hasVideo = await hasVideoStream(directPath);
      const hasAudio = await hasAudioStream(directPath);
      console.log(`[SocialVideo][Download] directInfo=${directPath} video=${hasVideo} audio=${hasAudio}`);
      if (hasVideo && hasAudio) rawPath = directPath;
    } catch (err) {
      console.warn('[SocialVideo] TikTok direct-info fallback failed:', err);
    }
  }
  if (!rawPath && /tiktok\.com/i.test(url)) {
    const fallbackPath = path.join(TMP_DIR, `${outBase}.browser.mp4`);
    console.warn('[SocialVideo] retrying TikTok browser fallback');
    try {
      await downloadTikTokViaBrowser(url, fallbackPath);
      candidates.push(fallbackPath);
      const hasVideo = await hasVideoStream(fallbackPath);
      const hasAudio = await hasAudioStream(fallbackPath);
      console.log(`[SocialVideo][Download] browserFallback=${fallbackPath} video=${hasVideo} audio=${hasAudio}`);
      if (hasVideo && hasAudio) rawPath = fallbackPath;
    } catch (err) {
      console.warn('[SocialVideo] TikTok browser fallback failed:', err);
    }
  }
  if (!rawPath && isThreads) {
    const snapSavePath = path.join(TMP_DIR, `${outBase}.snapsave.mp4`);
    console.warn('[SocialVideo] retrying Threads SnapSave fallback');
    try {
      await downloadThreadsViaSnapSave(url, snapSavePath);
      candidates.push(snapSavePath);
      const hasVideo = await hasVideoStream(snapSavePath);
      const hasAudio = await hasAudioStream(snapSavePath);
      console.log(`[SocialVideo][Download] snapSaveThreads=${snapSavePath} video=${hasVideo} audio=${hasAudio}`);
      if (hasVideo && hasAudio) rawPath = snapSavePath;
    } catch (err) {
      console.warn('[SocialVideo] SnapSave Threads fallback failed:', err);
    }
  }

  if (!rawPath && /tiktok\.com/i.test(url)) {
    const tikwmPath = path.join(TMP_DIR, `${outBase}.tikwm.mp4`);
    console.warn('[SocialVideo] retrying TikTok TikWM API fallback');
    try {
      await downloadTikTokViaTikwm(url, tikwmPath);
      candidates.push(tikwmPath);
      const hasVideo = await hasVideoStream(tikwmPath);
      const hasAudio = await hasAudioStream(tikwmPath);
      console.log(`[SocialVideo][Download] tikwmFallback=${tikwmPath} video=${hasVideo} audio=${hasAudio}`);
      if (hasVideo && hasAudio) rawPath = tikwmPath;
    } catch (err) {
      console.warn('[SocialVideo] TikWM fallback failed:', err);
    }
  }

  if (!rawPath) throw new Error(`yt-dlp/direct/browser did not create audio+video output for ${outBase}; refusing silent upload`);

  let meta: SocialVideoMeta | undefined;
  if (infoPath) {
    try {
      const json = await import('fs').then(fs => fs.readFileSync(infoPath, 'utf8'));
      meta = metaFromInfoJson(JSON.parse(json) as Record<string, unknown>, socialVideoLabel(url));
      console.log('[SocialVideo] Metadata:', JSON.stringify(meta));
    } catch (err) {
      console.warn('[SocialVideo] Info JSON metadata parse failed:', err);
    }
  }
  meta ??= await fetchSocialVideoMeta(url);
  if (!meta.title && !meta.uploader) meta = { ...meta, title: url };
  meta = { ...meta, sourceUrl: url };

  let outPath: string | undefined;
  try {
    console.log(`[SocialVideo][Normalize] start raw=${rawPath}${allowSilent ? ' (silent upload allowed for this key)' : ''}`);
    outPath = await normalizeForZalo(rawPath, '', allowSilent);
    console.log(`[SocialVideo][Normalize] OK out=${outPath} size=${statSync(outPath).size}`);
    if (!allowSilent && !(await hasAudioStream(outPath))) throw new Error(`Normalized social video has no audio stream; refusing to upload silent video: ${outPath}`);
    const durationSeconds = await probeDurationSeconds(rawPath);
    const paths = [outPath];
    meta = {
      ...meta,
      durationSeconds,
      sizeBytes: statSync(outPath).size,
    };
    return { paths, meta };
  } finally {
    for (const candidate of candidates) await cleanTemp(candidate);
  }
}

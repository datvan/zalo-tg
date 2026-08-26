import { createWriteStream, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { facebookCookieHeader, getFacebookBrowser } from './facebookBrowserSession.js';

async function downloadWithFetch(url: string, outPath: string): Promise<void> {
  const cookie = await facebookCookieHeader();
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
      'referer': 'https://www.facebook.com/',
      ...(cookie ? { cookie } : {}),
    },
  });
  if (!res.ok || !res.body) throw new Error(`Facebook video fetch failed: ${res.status} ${res.statusText}`);
  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(outPath);
    const nodeStream = Readable.fromWeb(res.body as never);
    nodeStream.pipe(file);
    nodeStream.on('error', reject);
    file.on('finish', resolve);
    file.on('error', reject);
  });
}

function decodeFacebookEscapedUrl(value: string): string {
  return value
    .replace(/\\\//g, '/')
    .replace(/\\u0025/g, '%')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/&amp;/g, '&');
}

type DashCandidate = { url: string; bandwidth: number; width: number; height: number };

function extractDashStreams(html: string, targetAspect?: number): { video?: DashCandidate; audio?: DashCandidate } {
  const representations = [...html.matchAll(/"mime_type":"(video|audio)\\\/mp4"[\s\S]{0,1600}?"base_url":"(https?:\\\/\\\/[^"]+)"[\s\S]{0,600}?(?="representation_id"|"mime_type"|$)/g)]
    .map(match => {
      const raw = match[0];
      const mime = match[1];
      const url = decodeFacebookEscapedUrl(match[2]);
      const bandwidth = Number(raw.match(/"bandwidth":(\d+)/)?.[1] ?? 0);
      const width = Number(raw.match(/"width":(\d+)/)?.[1] ?? 0);
      const height = Number(raw.match(/"height":(\d+)/)?.[1] ?? 0);
      return { mime, url, bandwidth, width, height };
    })
    .filter(x => x.url.includes('fbcdn.net') || x.url.includes('fbsbx.com'));
  const videos = representations.filter(x => x.mime === 'video');
  const audios = representations
    .filter(x => x.mime === 'audio')
    .sort((a, b) => b.bandwidth - a.bandwidth);
  // The page's hydration payload can embed manifests for more than one video (the target plus
  // preloaded feed neighbors) — "biggest resolution" alone can't tell them apart. When we have
  // an aspect-ratio fingerprint from the actual on-page target video, prefer a matching
  // representation over just the largest one; only fall back to "largest" if none match.
  const matching = targetAspect !== undefined
    ? videos.filter(x => x.width > 0 && x.height > 0 && aspectMatches(x.width / x.height, targetAspect))
    : [];
  const ranked = (matching.length ? matching : videos).sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  return { video: ranked[0], audio: audios[0] };
}

async function muxAudioVideo(videoPath: string, audioPath: string, outPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c', 'copy',
      '-movflags', '+faststart',
      outPath,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', d => { stderr += String(d); });
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`Facebook DASH mux ffmpeg exit ${code}: ${stderr.slice(-2000)}`)));
    ff.on('error', reject);
  });
}

function fullFacebookMediaUrl(value: string): string {
  const url = new URL(value);
  url.searchParams.delete('bytestart');
  url.searchParams.delete('byteend');
  url.searchParams.delete('range');
  return url.toString();
}

function mediaResponseSummary(value: string, len: number, ct: string): { host: string; path: string; len: number; ct: string; partial: boolean } {
  const url = new URL(value);
  return {
    host: url.host,
    path: url.pathname,
    len,
    ct,
    partial: url.searchParams.has('bytestart') || url.searchParams.has('byteend'),
  };
}

function bestSeenAv(seen: Array<{ url: string; len: number; ct: string }>): { video?: string; audio?: string } {
  const video = seen
    .filter(x => /video\/mp4/i.test(x.ct) && x.len > 300_000)
    .sort((a, b) => b.len - a.len)[0]?.url;
  const audio = seen
    .filter(x => /audio\/mp4/i.test(x.ct) && x.len > 20_000)
    .sort((a, b) => b.len - a.len)[0]?.url;
  return {
    video: video ? fullFacebookMediaUrl(video) : undefined,
    audio: audio ? fullFacebookMediaUrl(audio) : undefined,
  };
}

function fbCandidateUrl(url: string): string {
  const m = url.match(/story_fbid=(\d+)/i) ?? url.match(/\/(?:reel|watch)\/(\d+)/i);
  if (m?.[1]) return `https://www.facebook.com/reel/${m[1]}`;
  return url;
}

/**
 * Facebook's numeric post/video id, when present in the current URL. Reels/Watch pages are
 * an auto-advancing feed — scrolling or waiting on a slow/gated page can silently carry the
 * browser to a *different* recommended video. This id is the one thing we can check to tell
 * "still on the video we were asked for" from "feed moved on to something else", since the
 * CDN media URLs themselves are opaque tokens that don't reference the source post.
 */
function extractFacebookVideoId(url: string): string | undefined {
  try {
    const u = new URL(url);
    const pathId = u.pathname.match(/\/(?:reel|videos|watch)\/(\d{6,})/i)?.[1];
    if (pathId) return pathId;
    const paramId = u.searchParams.get('v') ?? u.searchParams.get('story_fbid');
    if (paramId && /^\d{6,}$/.test(paramId)) return paramId;
  } catch { /* ignore */ }
  return undefined;
}

export function facebookUnavailablePageReason(state: { title?: string; bodyHint?: string }): string | undefined {
  const text = `${state.title ?? ''}\n${state.bodyHint ?? ''}`.replace(/\s+/g, ' ').trim();
  if (/(log in to view|đăng nhập để xem|log in.*create new account)/i.test(text)) {
    return 'Facebook login/session is required or expired';
  }
  if (!/(this page isn't available at the moment|this content isn't available right now|the link you followed may be broken|sorry, this content isn't available|trang này hiện không khả dụng|nội dung này hiện không khả dụng)/i.test(text)) {
    return undefined;
  }
  return 'Facebook page unavailable for current session';
}

export interface TargetFingerprint {
  aspect: number;
  duration?: number;
  /** 64-bit average-hash of a decoded frame, as a 16-char hex string. */
  frameHash?: string;
  frameHashAtSeconds?: number;
}

/**
 * Facebook's Reels/Watch surface renders more than one <video> element at once (the target
 * plus the auto-preloaded "next in feed" item) and never populates a fetchable currentSrc/src
 * on either — so neither element identity nor its src can tell them apart directly. What IS
 * reliable: the FIRST <video> in DOM order is consistently the one for the URL we navigated
 * to. Three independent signals from it, checked in increasing strictness, make a same-aspect
 * coincidence between the target and a feed neighbor extremely unlikely to also collide on all
 * three: aspect ratio (from videoWidth/videoHeight, available almost immediately), duration
 * (available at the same time), and a perceptual hash of an actually-decoded frame (available
 * once playback produces real pixel data) — the frame hash alone directly verifies visual
 * content, not just metadata that two different clips could coincidentally share.
 */
async function captureTargetFingerprint(page: import('puppeteer').Page): Promise<TargetFingerprint | undefined> {
  let aspect: number | undefined;
  let duration: number | undefined;
  for (let i = 0; i < 25 && aspect === undefined; i++) {
    const dims = await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement | null;
      if (v) { v.muted = true; void v.play().catch(() => undefined); }
      if (!v || !v.videoWidth) return undefined;
      return { width: v.videoWidth, height: v.videoHeight, duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : undefined };
    }).catch(() => undefined);
    if (dims) { aspect = dims.width / dims.height; duration = dims.duration; }
    else await new Promise(r => setTimeout(r, 700));
  }
  if (aspect === undefined) return undefined;

  // Metadata (dims/duration) loads before actual pixels are decoded. Poll a bit further,
  // waiting for readyState to reach HAVE_CURRENT_DATA, so the hashed frame is real content.
  let frameHash: string | undefined;
  let frameHashAtSeconds: number | undefined;
  for (let i = 0; i < 10 && !frameHash; i++) {
    const captured = await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement | null;
      if (!v || v.readyState < 2 || !v.videoWidth) return undefined;
      const SIZE = 8;
      const canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) return undefined;
      ctx.drawImage(v, 0, 0, SIZE, SIZE);
      const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
      const gray: number[] = [];
      for (let p = 0; p < data.length; p += 4) gray.push((data[p] + data[p + 1] + data[p + 2]) / 3);
      return { gray, atSeconds: v.currentTime };
    }).catch(() => undefined);
    if (captured) {
      const mean = captured.gray.reduce((s, x) => s + x, 0) / captured.gray.length;
      frameHash = captured.gray.map(x => (x > mean ? '1' : '0')).join('');
      frameHash = BigInt('0b' + frameHash).toString(16).padStart(16, '0');
      frameHashAtSeconds = captured.atSeconds;
    } else {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return { aspect, duration, frameHash, frameHashAtSeconds };
}

async function probeAspect(filePath: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0:s=x',
      filePath,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    p.stdout.on('data', d => { stdout += String(d); });
    p.on('close', () => {
      const [w, h] = stdout.trim().split('x').map(Number);
      resolve(w > 0 && h > 0 ? w / h : undefined);
    });
    p.on('error', () => resolve(undefined));
  });
}

async function probeDuration(filePath: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    p.stdout.on('data', d => { stdout += String(d); });
    p.on('close', () => {
      const d = Number(stdout.trim());
      resolve(Number.isFinite(d) && d > 0 ? d : undefined);
    });
    p.on('error', () => resolve(undefined));
  });
}

/** Same 8x8 average-hash algorithm as captureTargetFingerprint's browser-side canvas capture,
 * computed instead via ffmpeg for a downloaded candidate file, at a matching timestamp. */
async function computeFrameHash(filePath: string, atSeconds: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', [
      '-v', 'error',
      '-ss', String(Math.max(0, atSeconds)),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', 'scale=8:8',
      '-pix_fmt', 'gray',
      '-f', 'rawvideo',
      'pipe:1',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    p.stdout.on('data', d => chunks.push(d));
    p.on('close', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length < 64) { resolve(undefined); return; }
      const mean = buf.reduce((s, x) => s + x, 0) / buf.length;
      const bits = Array.from(buf.subarray(0, 64), x => (x > mean ? '1' : '0')).join('');
      resolve(BigInt('0b' + bits).toString(16).padStart(16, '0'));
    });
    p.on('error', () => resolve(undefined));
  });
}

function hammingDistanceHex(a: string, b: string): number {
  const xor = BigInt('0x' + a) ^ BigInt('0x' + b);
  return xor.toString(2).split('').filter(c => c === '1').length;
}

function aspectMatches(a: number, b: number, tolerance = 0.08): boolean {
  return Math.abs(a - b) / b <= tolerance;
}

function durationMatches(a: number, b: number, toleranceSeconds = 2, toleranceRatio = 0.1): boolean {
  return Math.abs(a - b) <= Math.max(toleranceSeconds, b * toleranceRatio);
}

async function probeHasAudio(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    p.stdout.on('data', d => { stdout += String(d); });
    p.on('close', () => resolve(stdout.includes('audio')));
    p.on('error', () => resolve(false));
  });
}

export async function downloadFacebookViaBrowser(url: string, outPath: string): Promise<void> {
  const browser = await getFacebookBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });
    const seen: Array<{ url: string; len: number; ct: string }> = [];
    page.on('response', (res) => {
      const u = res.url();
      const h = res.headers();
      const ct = h['content-type'] ?? '';
      const len = Number(h['content-length'] ?? 0);
      if ((/video|audio|octet-stream/i.test(ct) || /\.mp4|video|audio|fbcdn|fbsbx/i.test(u)) && /fbcdn|fbsbx|facebook/i.test(u)) {
        seen.push({ url: u, len, ct });
      }
    });
    const targets = [url, fbCandidateUrl(url), url.replace('www.facebook.com', 'm.facebook.com')];
    let targetId: string | undefined;
    let domSrc: string | undefined;
    let driftedAwayFromTarget = false;
    for (const target of [...new Set(targets)]) {
      let navigated = false;
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
        navigated = true;
      } catch { /* keep trying */ }
      if (!navigated) continue;
      const pageState = await page.evaluate(() => ({
        title: document.title,
        bodyHint: document.body?.innerText?.slice(0, 2000),
        hasVideo: Boolean(document.querySelector('video')),
      })).catch(() => undefined);
      const unavailableReason = facebookUnavailablePageReason(pageState ?? {});
      if (unavailableReason) {
        throw new Error(`Facebook browser fallback: ${unavailableReason}; link may be private, removed, or unavailable for current session (url=${page.url()}).`);
      }
      targetId ??= extractFacebookVideoId(page.url());
      for (let i = 0; i < 35 && !domSrc; i++) {
        const state = await page.evaluate(() => {
          const bodyHint = document.body?.innerText?.slice(0, 2000);
          const els = [...document.querySelectorAll('div[role="button"], a[role="button"], button, span, a')] as HTMLElement[];
          const continueEl = els.find(e => /^(Continue as|Tiếp tục|Tiếp tục với|Continue|Log in as)/i.test((e.innerText || e.textContent || '').trim()));
          if (continueEl) {
            continueEl.click();
            return { clickedContinue: true, src: undefined, title: document.title, bodyHint };
          }
          const v = document.querySelector('video') as HTMLVideoElement | null;
          if (v) {
            v.muted = true;
            void v.play().catch(() => undefined);
            return { clickedContinue: false, src: v.currentSrc || v.src || undefined, title: document.title, bodyHint };
          }
          window.scrollBy(0, 180);
          return { clickedContinue: false, src: undefined, title: document.title, bodyHint };
        }).catch(() => ({ clickedContinue: false, src: undefined, title: '', bodyHint: '' }));
        if (state.clickedContinue) console.warn('[SocialVideo] Facebook browser fallback clicked Continue-as button');
        const unavailableReason = facebookUnavailablePageReason(state);
        if (unavailableReason) {
          throw new Error(`Facebook browser fallback: ${unavailableReason}; link may be private, removed, or unavailable for current session (url=${page.url()}).`);
        }
        if (state.src && /fbcdn|fbsbx|\.mp4/i.test(state.src)) domSrc = fullFacebookMediaUrl(state.src);
        // Reels/Watch is an auto-advancing feed: scrollBy() above (fired when no <video> is
        // found yet) can carry the SPA route to a different, unrelated video. If that happens,
        // stop immediately instead of scrolling further away from the target.
        if (targetId) {
          const currentId = extractFacebookVideoId(page.url());
          if (currentId && currentId !== targetId) {
            console.warn(`[SocialVideo] Facebook browser fallback: feed auto-advanced from target id=${targetId} to id=${currentId} — stopping scroll`);
            driftedAwayFromTarget = true;
            break;
          }
        }
        await new Promise(r => setTimeout(r, state.clickedContinue ? 3500 : 1000));
      }
      if (domSrc || driftedAwayFromTarget) break;
    }
    if (driftedAwayFromTarget) {
      throw new Error(`Facebook browser fallback: page navigated away from the target video (id=${targetId}) — refusing to upload unrelated content instead of guessing.`);
    }
    if (targetId) {
      const finalId = extractFacebookVideoId(page.url());
      if (finalId && finalId !== targetId) {
        throw new Error(`Facebook browser fallback: final page id=${finalId} does not match target id=${targetId} — refusing to upload unrelated content instead of guessing.`);
      }
    }

    // The Reels surface renders the target video PLUS the next-in-feed item's <video> element
    // simultaneously, and neither ever gets a fetchable currentSrc/src — so this fingerprint
    // (from the first, target, <video> element's decoded metadata AND an actual decoded frame)
    // is the only reliable way left to tell "this download is actually the target" from "this
    // is some other reel that happened to look biggest", which is what caused wrong videos to
    // be sent previously.
    const fingerprint = await captureTargetFingerprint(page);
    console.warn(`[SocialVideo] Facebook browser fallback target fingerprint aspect=${fingerprint?.aspect.toFixed(3) ?? 'unknown'} duration=${fingerprint?.duration?.toFixed(1) ?? 'unknown'} frameHash=${fingerprint?.frameHash ?? 'unavailable'}`);
    if (!fingerprint) {
      // Without ANY fingerprint there is no way to tell the target apart from a feed neighbor —
      // accepting "whatever downloads" here is exactly the historical bug. Fail closed instead;
      // the durable queue retries this job rather than risk posting unrelated content.
      throw new Error('Facebook browser fallback could not establish a target video fingerprint (page loaded too slowly or the video element never reported metadata) — refusing to guess at which candidate is correct.');
    }

    const dash = extractDashStreams(await page.content().catch(() => ''), fingerprint.aspect);
    console.warn(`[SocialVideo] Facebook DASH manifest scan: video=${dash.video ? `found ${dash.video.width}x${dash.video.height}` : 'missing'} audio=${dash.audio ? `found bw=${dash.audio.bandwidth}` : 'missing'}`);

    const rankedVideoCandidates = [
      ...(domSrc ? [domSrc] : []),
      ...(dash.video ? [dash.video.url] : []),
      ...seen.filter(x => /video\/mp4/i.test(x.ct) && x.len > 300_000).sort((a, b) => b.len - a.len).map(x => fullFacebookMediaUrl(x.url)),
    ];
    const seenTop = seen
      .sort((a, b) => b.len - a.len)
      .slice(0, 8)
      .map(item => mediaResponseSummary(item.url, item.len, item.ct));

    let acceptedVideoPath: string | undefined;
    const tmpVideoPath = `${outPath}.candidate.mp4`;
    for (const candidateUrl of [...new Set(rankedVideoCandidates)]) {
      try {
        await downloadWithFetch(candidateUrl, tmpVideoPath);
        const aspect = await probeAspect(tmpVideoPath);
        if (aspect === undefined) { try { unlinkSync(tmpVideoPath); } catch { /* ignore */ } continue; }
        if (fingerprint?.aspect !== undefined && !aspectMatches(aspect, fingerprint.aspect)) {
          console.warn(`[SocialVideo] Facebook browser fallback: discarding candidate — aspect ${aspect.toFixed(3)} vs target ${fingerprint.aspect.toFixed(3)}, url=${candidateUrl.slice(0, 100)}`);
          try { unlinkSync(tmpVideoPath); } catch { /* ignore */ }
          continue;
        }
        if (fingerprint?.duration !== undefined) {
          const duration = await probeDuration(tmpVideoPath);
          if (duration !== undefined && !durationMatches(duration, fingerprint.duration)) {
            console.warn(`[SocialVideo] Facebook browser fallback: discarding candidate — duration ${duration.toFixed(1)}s vs target ${fingerprint.duration.toFixed(1)}s, url=${candidateUrl.slice(0, 100)}`);
            try { unlinkSync(tmpVideoPath); } catch { /* ignore */ }
            continue;
          }
        }
        if (fingerprint?.frameHash !== undefined && fingerprint.frameHashAtSeconds !== undefined) {
          const candidateHash = await computeFrameHash(tmpVideoPath, fingerprint.frameHashAtSeconds);
          if (candidateHash !== undefined) {
            const distance = hammingDistanceHex(candidateHash, fingerprint.frameHash);
            if (distance > 12) {
              console.warn(`[SocialVideo] Facebook browser fallback: discarding candidate — frame hash distance=${distance}/64 (aspect+duration matched but visual content did not), url=${candidateUrl.slice(0, 100)}`);
              try { unlinkSync(tmpVideoPath); } catch { /* ignore */ }
              continue;
            }
            console.warn(`[SocialVideo] Facebook browser fallback: candidate frame hash distance=${distance}/64 — accepting`);
          }
        }
        acceptedVideoPath = tmpVideoPath;
        break;
      } catch { /* try next candidate */ }
    }

    if (!acceptedVideoPath) {
      const pageState = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        hasVideo: Boolean(document.querySelector('video')),
        bodyHint: document.body?.innerText?.slice(0, 240),
      })).catch(() => undefined);
      console.warn(`[SocialVideo] Facebook browser fallback no-matching-video state=${JSON.stringify(pageState)} seenTop=${JSON.stringify(seenTop)}`);
      throw new Error('Facebook browser fallback could not find a video response matching the target (checked DOM src, DASH manifest, and network traffic, verified by aspect ratio + duration + frame hash). Refusing to upload unrelated content; see PM2 logs for pageState/seenTop.');
    }
    console.warn(`[SocialVideo] Facebook browser fallback accepted video candidate; checked ${rankedVideoCandidates.length} candidate(s)`);

    try {
      if (await probeHasAudio(acceptedVideoPath)) {
        // The winning candidate is already a muxed AV file (can happen for non-Reels posts) —
        // use it as-is.
        writeFileSync(outPath, readFileSync(acceptedVideoPath));
        return;
      }
      const audioUrl = dash.audio?.url ?? bestSeenAv(seen).audio;
      if (!audioUrl) {
        // No audio anywhere for this content — hand back the (verified-correct) silent video
        // as-is; the caller's own hasAudioStream() gate decides whether to accept it.
        writeFileSync(outPath, readFileSync(acceptedVideoPath));
        return;
      }
      const audioPath = `${outPath}.audio.m4a`;
      try {
        await downloadWithFetch(audioUrl, audioPath);
        console.warn(`[SocialVideo] Facebook fallback muxing verified video with best-available audio track`);
        await muxAudioVideo(acceptedVideoPath, audioPath, outPath);
      } finally {
        try { unlinkSync(audioPath); } catch { /* ignore */ }
      }
    } finally {
      try { unlinkSync(acceptedVideoPath); } catch { /* ignore */ }
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}

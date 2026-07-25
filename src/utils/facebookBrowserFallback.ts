import { createWriteStream, readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import path from 'path';
import puppeteer, { type CookieParam } from 'puppeteer';

const DEFAULT_FB_COOKIE_JSON = 'J:\\CrawBot\\Cookies\\www.facebook.com_12-07-2026.json';
const DEFAULT_FB_COOKIE_NETSCAPE = path.resolve(process.cwd(), 'data', 'facebook-cookies.txt');

function cookieParamsFromJson(file: string): CookieParam[] {
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, 'utf8')) as { cookies?: Array<Record<string, unknown>> };
  return (data.cookies ?? []).map(c => ({
    name: String(c.name ?? ''),
    value: String(c.value ?? ''),
    domain: String(c.domain ?? '.facebook.com'),
    path: String(c.path ?? '/'),
    expires: typeof c.expirationDate === 'number' ? Math.floor(c.expirationDate) : undefined,
    httpOnly: Boolean(c.httpOnly),
    secure: c.secure !== false,
    sameSite: 'None' as const,
  })).filter(c => c.name && c.value);
}

function netscapeCookieRows(file: string): string[][] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/)
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('\t'))
    .filter(p => p.length >= 7);
}

function cookieHeaderFromNetscape(file: string): string {
  return netscapeCookieRows(file).map(p => `${p[5]}=${p[6]}`).join('; ');
}

function cookieParamsFromNetscape(file: string): CookieParam[] {
  return netscapeCookieRows(file).map(p => ({
    name: p[5],
    value: p[6],
    domain: p[0]?.replace(/^#HttpOnly_/, '') || '.facebook.com',
    path: p[2] || '/',
    expires: Number.isFinite(Number(p[4])) && Number(p[4]) > 0 ? Number(p[4]) : undefined,
    httpOnly: p[0]?.startsWith('#HttpOnly_') ?? false,
    secure: /^TRUE$/i.test(p[3] ?? ''),
    sameSite: 'None' as const,
  })).filter(c => c.name && c.value);
}

async function downloadWithFetch(url: string, outPath: string): Promise<void> {
  const cookie = cookieHeaderFromNetscape(process.env.FB_COOKIES_PATH?.trim() || DEFAULT_FB_COOKIE_NETSCAPE);
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

/**
 * Facebook's Reels/Watch surface renders more than one <video> element at once (the target
 * plus the auto-preloaded "next in feed" item) and never populates a fetchable currentSrc/src
 * on either — so neither element identity nor its src can tell them apart directly. What IS
 * reliable: the FIRST <video> in DOM order is consistently the one for the URL we navigated
 * to, and its videoWidth/videoHeight (populated from preloaded metadata almost immediately,
 * well before any src is assigned) gives a stable aspect-ratio fingerprint for the target
 * content — which every other extraction path below can be checked against.
 */
async function captureTargetAspect(page: import('puppeteer').Page): Promise<number | undefined> {
  for (let i = 0; i < 15; i++) {
    const dims = await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement | null;
      if (v) { v.muted = true; void v.play().catch(() => undefined); }
      return v && v.videoWidth ? { width: v.videoWidth, height: v.videoHeight } : undefined;
    }).catch(() => undefined);
    if (dims && dims.width > 0 && dims.height > 0) return dims.width / dims.height;
    await new Promise(r => setTimeout(r, 700));
  }
  return undefined;
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

function aspectMatches(a: number, b: number, tolerance = 0.08): boolean {
  return Math.abs(a - b) / b <= tolerance;
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
  const cookieJson = process.env.FB_COOKIE_JSON_PATH?.trim() || DEFAULT_FB_COOKIE_JSON;
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });
    const cookieNet = process.env.FB_COOKIES_PATH?.trim() || DEFAULT_FB_COOKIE_NETSCAPE;
    const cookies = [...cookieParamsFromJson(cookieJson), ...cookieParamsFromNetscape(cookieNet)];
    if (cookies.length) await page.setCookie(...cookies);
    console.warn(`[SocialVideo] Facebook browser fallback cookies json=${cookieParamsFromJson(cookieJson).length} netscape=${cookieParamsFromNetscape(cookieNet).length}`);
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
      try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch { /* keep trying */ }
      targetId ??= extractFacebookVideoId(page.url());
      for (let i = 0; i < 35 && !domSrc; i++) {
        const state = await page.evaluate(() => {
          const els = [...document.querySelectorAll('div[role="button"], a[role="button"], button, span, a')] as HTMLElement[];
          const continueEl = els.find(e => /^(Continue as|Tiếp tục|Tiếp tục với|Continue|Log in as)/i.test((e.innerText || e.textContent || '').trim()));
          if (continueEl) {
            continueEl.click();
            return { clickedContinue: true, src: undefined };
          }
          const v = document.querySelector('video') as HTMLVideoElement | null;
          if (v) { v.muted = true; void v.play().catch(() => undefined); return { clickedContinue: false, src: v.currentSrc || v.src || undefined }; }
          window.scrollBy(0, 180);
          return { clickedContinue: false, src: undefined };
        }).catch(() => ({ clickedContinue: false, src: undefined }));
        if (state.clickedContinue) console.warn('[SocialVideo] Facebook browser fallback clicked Continue-as button');
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
    // (from the first, target, <video> element's decoded metadata) is the only reliable way
    // left to tell "this download is actually the target" from "this is some other reel that
    // happened to look biggest", which is what caused wrong videos to be sent previously.
    const targetAspect = await captureTargetAspect(page);
    console.warn(`[SocialVideo] Facebook browser fallback target aspect=${targetAspect?.toFixed(3) ?? 'unknown'}`);

    const dash = extractDashStreams(await page.content().catch(() => ''), targetAspect);
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
        if (targetAspect !== undefined && !aspectMatches(aspect, targetAspect)) {
          console.warn(`[SocialVideo] Facebook browser fallback: discarding candidate aspect=${aspect.toFixed(3)} vs target=${targetAspect.toFixed(3)} url=${candidateUrl.slice(0, 100)}`);
          try { unlinkSync(tmpVideoPath); } catch { /* ignore */ }
          continue;
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
      throw new Error('Facebook browser fallback could not find a video response matching the target (checked DOM src, DASH manifest, and network traffic, verified by aspect ratio). Refusing to upload unrelated content; see PM2 logs for pageState/seenTop.');
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
    const pages = await browser.pages().catch(() => []);
    await Promise.all(pages.map(p => p.close().catch(() => undefined)));
    await browser.close().catch(() => undefined);
  }
}

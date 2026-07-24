import { createWriteStream, readFileSync, existsSync, writeFileSync, statSync, unlinkSync } from 'fs';
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

function extractDashStreams(html: string): { video?: DashCandidate; audio?: DashCandidate } {
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
  const videos = representations
    .filter(x => x.mime === 'video')
    .sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  const audios = representations
    .filter(x => x.mime === 'audio')
    .sort((a, b) => b.bandwidth - a.bandwidth);
  return { video: videos[0], audio: audios[0] };
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
    let candidate: string | undefined;
    let candidateBuffer: Buffer | undefined;
    const seen: Array<{ url: string; len: number; ct: string }> = [];
    page.on('response', async (res) => {
      const u = res.url();
      const h = res.headers();
      const ct = h['content-type'] ?? '';
      const len = Number(h['content-length'] ?? 0);
      if ((/video|audio|octet-stream/i.test(ct) || /\.mp4|video|audio|fbcdn|fbsbx/i.test(u)) && /fbcdn|fbsbx|facebook/i.test(u)) {
        seen.push({ url: u, len, ct });
        if (!candidate && len > 500_000 && /\.mp4|video/i.test(u)) {
          candidate = fullFacebookMediaUrl(u);
          try {
            const buf = await res.buffer();
            if (buf.length > 500_000) candidateBuffer = buf;
          } catch { /* body may be unavailable for some responses */ }
        }
      }
    });
    const targets = [url, fbCandidateUrl(url), url.replace('www.facebook.com', 'm.facebook.com')];
    for (const target of [...new Set(targets)]) {
      try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch { /* keep trying */ }
      for (let i = 0; i < 35 && !candidate; i++) {
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
        if (state.src && /fbcdn|fbsbx|\.mp4/i.test(state.src)) candidate = fullFacebookMediaUrl(state.src);
        await new Promise(r => setTimeout(r, state.clickedContinue ? 3500 : 1000));
      }
      if (candidate) break;
    }
    const dash = extractDashStreams(await page.content().catch(() => ''));
    // Distinguishes "our extraction failed" from "Facebook never advertised audio for this
    // content" — if the manifest embedded in the page itself has no audio representation,
    // no downloader (this one or any third-party one) can recover audio for it either.
    console.warn(`[SocialVideo] Facebook DASH manifest scan: video=${dash.video ? `found ${dash.video.width}x${dash.video.height}` : 'missing'} audio=${dash.audio ? `found bw=${dash.audio.bandwidth}` : 'missing'}`);
    if (dash.video && dash.audio) {
      const videoPath = `${outPath}.video.mp4`;
      const audioPath = `${outPath}.audio.m4a`;
      console.warn(`[SocialVideo] Facebook DASH fallback found video=${dash.video.width}x${dash.video.height} bw=${dash.video.bandwidth} audioBw=${dash.audio.bandwidth}`);
      try {
        await downloadWithFetch(dash.video.url, videoPath);
        await downloadWithFetch(dash.audio.url, audioPath);
        console.warn(`[SocialVideo] Facebook DASH fallback downloaded videoBytes=${statSync(videoPath).size} audioBytes=${statSync(audioPath).size}`);
        await muxAudioVideo(videoPath, audioPath, outPath);
      } finally {
        try { unlinkSync(videoPath); } catch { /* ignore */ }
        try { unlinkSync(audioPath); } catch { /* ignore */ }
      }
      return;
    }
    const av = bestSeenAv(seen);
    if (av.video && av.audio) {
      const videoPath = `${outPath}.video.mp4`;
      const audioPath = `${outPath}.audio.m4a`;
      console.warn('[SocialVideo] Facebook network AV fallback found separate audio+video responses');
      try {
        await downloadWithFetch(av.video, videoPath);
        await downloadWithFetch(av.audio, audioPath);
        console.warn(`[SocialVideo] Facebook network AV fallback downloaded videoBytes=${statSync(videoPath).size} audioBytes=${statSync(audioPath).size}`);
        await muxAudioVideo(videoPath, audioPath, outPath);
      } finally {
        try { unlinkSync(videoPath); } catch { /* ignore */ }
        try { unlinkSync(audioPath); } catch { /* ignore */ }
      }
      return;
    }
    candidate ??= seen.filter(x => x.len > 500_000).sort((a, b) => b.len - a.len)[0]?.url;
    if (candidate) candidate = fullFacebookMediaUrl(candidate);
    const seenTop = seen
      .sort((a, b) => b.len - a.len)
      .slice(0, 8)
      .map(item => mediaResponseSummary(item.url, item.len, item.ct));
    console.warn(`[SocialVideo] Facebook browser fallback seenTop=${JSON.stringify(seenTop)}`);
    if (!candidate) {
      const pageState = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        hasVideo: Boolean(document.querySelector('video')),
        bodyHint: document.body?.innerText?.slice(0, 240),
      })).catch(() => undefined);
      console.warn(`[SocialVideo] Facebook browser fallback no-video state=${JSON.stringify(pageState)} seenTop=${JSON.stringify(seenTop)}`);
      throw new Error('Facebook browser fallback could not find a playable video response. Likely Facebook auth/privacy/checkpoint or unsupported share page; see PM2 logs for pageState/seenTop.');
    }
    console.warn(`[SocialVideo] Facebook browser fallback video URL found; candidates=${seen.length}; buffered=${candidateBuffer?.length ?? 0}`);
    if (candidateBuffer && candidateBuffer.length > 8_000_000) writeFileSync(outPath, candidateBuffer);
    else await downloadWithFetch(candidate, outPath);
  } finally {
    const pages = await browser.pages().catch(() => []);
    await Promise.all(pages.map(p => p.close().catch(() => undefined)));
    await browser.close().catch(() => undefined);
  }
}

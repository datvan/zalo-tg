import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import puppeteer from 'puppeteer';

async function downloadWithFetch(url: string, outPath: string): Promise<void> {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
      'referer': 'https://www.tiktok.com/',
      'range': 'bytes=0-',
    },
  });
  if (!res.ok || !res.body) throw new Error(`TikTok video fetch failed: ${res.status} ${res.statusText}`);
  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(outPath);
    const nodeStream = Readable.fromWeb(res.body as never);
    nodeStream.pipe(file);
    nodeStream.on('error', reject);
    file.on('finish', resolve);
    file.on('error', reject);
  });
}

function tikTokVideoId(url: string): string | undefined {
  return url.match(/\/video\/(\d+)/i)?.[1];
}

export async function downloadTikTokViaBrowser(url: string, outPath: string): Promise<void> {
  const videoId = tikTokVideoId(url);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    let candidate: string | undefined;
    const seen: Array<{ url: string; len: number; ct: string }> = [];
    page.on('response', async (res) => {
      const u = res.url();
      const h = res.headers();
      const ct = h['content-type'] ?? '';
      const len = Number(h['content-length'] ?? 0);
      if (/video|octet-stream/i.test(ct) && /tiktok|tiktokcdn|byteoversea|muscdn/i.test(u)) {
        seen.push({ url: u, len, ct });
        // Avoid tiny thumbnails/previews. The failing wrong capture was ~325KB.
        if (!candidate && len > 1_000_000 && (!videoId || u.includes(videoId) || seen.length > 1)) candidate = u;
      }
    });
    const mobileUrl = url.replace('www.tiktok.com', 'm.tiktok.com');
    await page.goto(mobileUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    for (let i = 0; i < 25 && !candidate; i++) {
      await page.evaluate(() => {
        const v = document.querySelector('video') as HTMLVideoElement | null;
        if (v) { v.muted = true; void v.play().catch(() => undefined); }
        window.scrollBy(0, 50);
      }).catch(() => undefined);
      await new Promise(r => setTimeout(r, 1000));
      // Do not trust video.currentSrc here; TikTok may expose a tiny preview/placeholder.
    }
    candidate ??= seen.filter(x => x.len > 1_000_000).sort((a, b) => b.len - a.len)[0]?.url;
    if (!candidate) throw new Error(`TikTok browser fallback could not find full video response; seen=${JSON.stringify(seen.slice(-8))}`);
    console.warn(`[SocialVideo] TikTok browser fallback video URL found; candidates=${seen.length}`);
    await downloadWithFetch(candidate, outPath);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

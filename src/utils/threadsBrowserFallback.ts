import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import puppeteer from 'puppeteer';

export interface ThreadsVideoCandidate {
  src: string;
  top: number;
  left: number;
  width: number;
  height: number;
  viewportHeight: number;
}

/** Pick media from the target post viewport; never guess from feed downloads. */
export function selectThreadsTargetVideo(candidates: readonly ThreadsVideoCandidate[]): string | undefined {
  return candidates
    .filter(candidate => candidate.src && candidate.width > 0 && candidate.height > 0
      && candidate.top < candidate.viewportHeight && candidate.top + candidate.height > 0)
    .sort((a, b) => a.top - b.top || a.left - b.left)[0]?.src;
}

async function downloadWithFetch(url: string, outPath: string): Promise<void> {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
      'referer': 'https://www.threads.com/',
      'range': 'bytes=0-',
    },
  });
  if (!res.ok || !res.body) throw new Error(`Threads video fetch failed: ${res.status} ${res.statusText}`);
  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(outPath);
    const nodeStream = Readable.fromWeb(res.body as never);
    nodeStream.pipe(file);
    nodeStream.on('error', reject);
    file.on('finish', resolve);
    file.on('error', reject);
  });
}

export async function downloadThreadsViaBrowser(url: string, outPath: string): Promise<void> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    const seen: Array<{ url: string; len: number; ct: string }> = [];
    page.on('response', async (res) => {
      const u = res.url();
      const h = res.headers();
      const ct = h['content-type'] ?? '';
      const len = Number(h['content-length'] ?? 0);
      if (/video|octet-stream/i.test(ct) && /cdninstagram|fbcdn|threads/i.test(u)) {
        seen.push({ url: u, len, ct });
      }
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    let candidate: string | undefined;
    for (let i = 0; i < 8 && !candidate; i++) {
      const videos = await page.evaluate(() => {
        const viewportHeight = window.innerHeight;
        return [...document.querySelectorAll('video')].map(video => {
          const rect = video.getBoundingClientRect();
          if (rect.top < viewportHeight && rect.bottom > 0) {
            video.muted = true;
            void video.play().catch(() => undefined);
          }
          return {
            src: video.currentSrc || video.src,
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            viewportHeight,
          };
        });
      }).catch(() => [] as ThreadsVideoCandidate[]);
      candidate = selectThreadsTargetVideo(videos);
      if (!candidate) await new Promise(r => setTimeout(r, 750));
    }
    if (!candidate) throw new Error(`Threads browser fallback could not find target video in the visible post; networkCandidates=${seen.length}`);
    console.warn(`[SocialVideo] Threads browser fallback selected target viewport video; networkCandidates=${seen.length}`);
    await downloadWithFetch(candidate, outPath);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

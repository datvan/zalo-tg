import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import puppeteer, { type Browser, type Cookie } from 'puppeteer';
import { markHealth } from '../health.js';

/**
 * Persistent Chrome profile that carries a real, logged-in Facebook session on disk — replaces
 * the previous approach of importing a hand-exported cookie JSON file, which went stale roughly
 * monthly and required a code change + redeploy every time (the file path was hardcoded per
 * export date). Login once via `scripts/login-facebook-profile.mjs`; Facebook then refreshes the
 * session itself as long as this profile keeps getting used, which the health-check below does.
 */
export const FB_PROFILE_DIR = process.env.FB_PROFILE_DIR?.trim() || path.resolve(process.cwd(), 'data', 'fb-profile');

/** Netscape-format cookie file yt-dlp's `--cookies` flag consumes. Kept fresh by
 * `refreshFacebookCookiesFile()`, exported from the same persistent-profile session. */
export const FB_NETSCAPE_COOKIES_PATH = process.env.FB_COOKIES_PATH?.trim()
  || path.resolve(process.cwd(), 'data', 'facebook-cookies.txt');

let browserPromise: Promise<Browser> | undefined;

async function launchBrowser(): Promise<Browser> {
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: FB_PROFILE_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
  });
  browser.on('disconnected', () => { browserPromise = undefined; });
  return browser;
}

/** Shared singleton so every Facebook fallback download and the periodic session health-check
 * reuse one Chrome process against the profile directory. A profile's on-disk SingletonLock
 * rejects a second concurrent launch against the same userDataDir — relaunching per call (like
 * the old ephemeral-browser code did) would make concurrent Facebook downloads fight over the
 * lock. Reusing one browser and opening a page per call avoids that entirely. */
export async function getFacebookBrowser(): Promise<Browser> {
  if (!browserPromise) browserPromise = launchBrowser();
  try {
    return await browserPromise;
  } catch (err) {
    browserPromise = undefined;
    throw err;
  }
}

export function cookieToNetscapeRow(c: Pick<Cookie, 'name' | 'value' | 'domain' | 'path' | 'secure' | 'httpOnly' | 'expires' | 'session'>): string {
  const prefix = c.httpOnly ? '#HttpOnly_' : '';
  const includeSubdomains = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const secure = c.secure ? 'TRUE' : 'FALSE';
  const expiry = c.session || c.expires <= 0 ? '0' : String(Math.floor(c.expires));
  return [`${prefix}${c.domain}`, includeSubdomains, c.path || '/', secure, expiry, c.name, c.value].join('\t');
}

/** Exports the profile's current Facebook cookies to the Netscape file yt-dlp reads. Refuses to
 * overwrite a good file with an anonymous/logged-out session (no c_user/xs) — returns false in
 * that case, leaving whatever cookie file already exists on disk untouched. */
export async function refreshFacebookCookiesFile(): Promise<boolean> {
  const browser = await getFacebookBrowser();
  const cookies = (await browser.cookies()).filter(c => c.domain === 'facebook.com' || c.domain.endsWith('.facebook.com'));
  if (!cookies.some(c => c.name === 'c_user') || !cookies.some(c => c.name === 'xs')) return false;
  mkdirSync(path.dirname(FB_NETSCAPE_COOKIES_PATH), { recursive: true });
  const lines = ['# Netscape HTTP Cookie File', ...cookies.map(cookieToNetscapeRow)];
  writeFileSync(FB_NETSCAPE_COOKIES_PATH, `${lines.join('\n')}\n`, { mode: 0o600 });
  return true;
}

/** Builds a `Cookie: name=value; ...` header for Node-side `fetch()` calls (the CDN video/audio
 * downloads happen outside the page context, so the browser's own cookie jar doesn't apply). */
export async function facebookCookieHeader(): Promise<string> {
  const browser = await getFacebookBrowser();
  return (await browser.cookies())
    .filter(c => c.domain === 'facebook.com' || c.domain.endsWith('.facebook.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

/** Facebook's logged-out homepage always renders an email/password login form — a reliable,
 * cheap signal that doesn't depend on guessing localized "please log in" copy. */
export async function checkFacebookSessionAlive(): Promise<{ alive: boolean; reason?: string }> {
  const browser = await getFacebookBrowser();
  const page = await browser.newPage();
  try {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const state = await page.evaluate(() => ({
      hasLoginForm: Boolean(document.querySelector('input[name="email"], input[name="pass"]')),
      title: document.title,
    }));
    if (state.hasLoginForm) {
      return { alive: false, reason: `Facebook home page rendered a login form (title="${state.title}") — session expired or logged out.` };
    }
    return { alive: true };
  } finally {
    await page.close().catch(() => undefined);
  }
}

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60_000; // 6h — frequent enough to catch a dead session fast, cheap enough to not matter.
const ALERT_COOLDOWN_MS = 12 * 60 * 60_000; // avoid re-alerting every 6h while the operator hasn't fixed it yet.
let lastAlertAt = 0;

/** Runs immediately and then on an interval: confirms the persistent profile's Facebook session
 * still works, keeps yt-dlp's cookie file fresh while it does, and calls `onSessionDead` (rate
 * limited) the moment it stops working — the whole point being to replace "found out a video
 * silently failed" with an explicit, immediate alert. */
export function startFacebookSessionWatchdog(onSessionDead: (reason: string) => void): void {
  const run = async () => {
    let result: { alive: boolean; reason?: string };
    try {
      result = await checkFacebookSessionAlive();
    } catch (err) {
      console.warn('[FacebookSession] health-check failed:', err instanceof Error ? err.message : err);
      return;
    }
    if (result.alive) {
      await refreshFacebookCookiesFile().catch(err => console.warn('[FacebookSession] cookie export failed:', err));
      markHealth({ fbSessionOk: true, fbSessionCheckedAt: new Date().toISOString(), fbSessionError: undefined });
      return;
    }
    markHealth({ fbSessionOk: false, fbSessionCheckedAt: new Date().toISOString(), fbSessionError: result.reason });
    console.warn(`[FacebookSession] session dead: ${result.reason}`);
    const now = Date.now();
    if (now - lastAlertAt > ALERT_COOLDOWN_MS) {
      lastAlertAt = now;
      onSessionDead(result.reason ?? 'unknown');
    }
  };
  void run();
  setInterval(run, Number(process.env.FB_SESSION_CHECK_INTERVAL_MS || DEFAULT_CHECK_INTERVAL_MS)).unref();
}

// One-time (and occasional re-run, if Facebook forces a full logout) manual login for the
// persistent Chrome profile the bridge uses for Facebook video downloads. Run this headed;
// log in by hand (including any 2FA/checkpoint), then press Enter in this terminal — the
// profile keeps the session on disk from then on, and the bridge's own periodic health-check
// (facebookBrowserSession.ts) keeps it fresh and alerts if it ever dies.
//
// Usage: node scripts/login-facebook-profile.mjs
import puppeteer from 'puppeteer';
import readline from 'readline/promises';
import { FB_PROFILE_DIR } from '../dist/utils/facebookBrowserSession.js';

console.log(`[login-facebook-profile] Using profile dir: ${FB_PROFILE_DIR}`);
const browser = await puppeteer.launch({
  headless: false,
  userDataDir: FB_PROFILE_DIR,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });

console.log('\nLog in to Facebook in the opened browser window (email/password, 2FA if prompted).');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question('Press Enter here once you are logged in and see your Facebook feed... ');
rl.close();

const cookies = await browser.cookies();
const loggedIn = cookies.some(c => c.name === 'c_user') && cookies.some(c => c.name === 'xs');
await browser.close();

if (!loggedIn) {
  console.error('[login-facebook-profile] No c_user/xs session cookie found — login did not complete. Re-run and try again.');
  process.exit(1);
}
console.log('[login-facebook-profile] Login confirmed (c_user + xs present). Profile saved — restart the bridge (pm2 restart zalo-tg) to pick it up.');

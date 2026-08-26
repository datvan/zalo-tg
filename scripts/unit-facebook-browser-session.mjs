import assert from 'assert/strict';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'fs';
import os from 'os';
import path from 'path';

const profileDir = mkdtempSync(path.join(os.tmpdir(), 'zalo-tg-facebook-test-'));
const cookiesPath = path.join(profileDir, 'facebook-cookies.txt');
process.env.FB_PROFILE_DIR = profileDir;
process.env.FB_COOKIES_PATH = cookiesPath;
const session = await import('../dist/utils/facebookBrowserSession.js');

const row = session.cookieToNetscapeRow({
  name: 'c_user', value: '123', domain: '.facebook.com', path: '/',
  secure: true, httpOnly: true, expires: 1234567890, session: false,
});
assert.equal(row, '#HttpOnly_.facebook.com\tTRUE\t/\tTRUE\t1234567890\tc_user\t123');

const sessionRow = session.cookieToNetscapeRow({
  name: 'sb', value: 'abc', domain: 'facebook.com', path: '/',
  secure: false, httpOnly: false, expires: -1, session: true,
});
assert.equal(sessionRow, 'facebook.com\tFALSE\t/\tFALSE\t0\tsb\tabc');

// Not-logged-in profile (fresh test run, no manual login done): refresh must refuse to write —
// this is the guard that stops the yt-dlp cookie file from ever being overwritten with a
// logged-out/anonymous session.
if (existsSync(session.FB_NETSCAPE_COOKIES_PATH)) unlinkSync(session.FB_NETSCAPE_COOKIES_PATH);
const refreshed = await session.refreshFacebookCookiesFile();
assert.equal(refreshed, false);
assert.equal(existsSync(session.FB_NETSCAPE_COOKIES_PATH), false);

const alive = await session.checkFacebookSessionAlive();
assert.equal(alive.alive, false);
assert.match(alive.reason ?? '', /login form/);

const browser = await session.getFacebookBrowser();
await browser.close();
rmSync(profileDir, { recursive: true, force: true });

console.log('facebook browser session guard ok');

import assert from 'assert/strict';
import os from 'os';
import path from 'path';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';

const socialVideo = await import('../dist/utils/socialVideo.js');
const policy = await import('../dist/utils/socialVideoPolicy.js');
const selfVideo = await import('../dist/utils/selfVideoCaption.js');
const facebookFallback = await import('../dist/utils/facebookBrowserFallback.js');
const threadsFallback = await import('../dist/utils/threadsBrowserFallback.js');
const store = await import('../dist/store.js');
const telegramHandlerSource = readFileSync(new URL('../src/telegram/handler.ts', import.meta.url), 'utf8');
assert.match(telegramHandlerSource, /enqueueDurableSocialVideoJob\(api, job\)/);
const youtubeUrl = 'https://www.youtube.com/shorts/FA403sF_D30';
assert.deepEqual(socialVideo.extractSocialVideoUrls(youtubeUrl), [youtubeUrl]);
assert.equal(socialVideo.canonicalSocialVideoKey(youtubeUrl), 'youtube:FA403sF_D30');

const fbUrl = 'https://www.facebook.com/share/v/1Bf9EHKk2k/?mibextid=wwXIfr';
const urls = socialVideo.extractSocialVideoUrls(`${fbUrl}. ${fbUrl} https://www.tiktok.com/@user/photo/123`);
assert.deepEqual(urls, [fbUrl]);
assert.equal(socialVideo.canonicalSocialVideoKey(fbUrl), 'facebook:share/v/1Bf9EHKk2k');
assert.match(socialVideo.extractUnsupportedSocialPostUrl('https://www.facebook.com/share/post/123')?.reason ?? '', /video/);

const threadsUrl = 'https://www.threads.com/@creator/post/Dbt7f55kwAc?x=1';
assert.deepEqual(socialVideo.extractSocialVideoUrls(`${threadsUrl} https://www.threads.com/@creator`), [threadsUrl]);
assert.equal(socialVideo.canonicalSocialVideoKey(threadsUrl), 'threads:Dbt7f55kwAc');
assert.equal(threadsFallback.selectThreadsTargetVideo([
  { src: 'below', top: 1800, left: 0, width: 240, height: 430, viewportHeight: 844 },
  { src: 'target', top: 200, left: 0, width: 240, height: 430, viewportHeight: 844 },
]), 'target');
assert.equal(threadsFallback.selectThreadsTargetVideo([
  { src: 'below', top: 1800, left: 0, width: 240, height: 430, viewportHeight: 844 },
]), undefined);

const caption = socialVideo.formatSocialVideoCaption({
  platform: 'Facebook Reels',
  title: 'Example video',
  durationSeconds: 15.833,
  sizeBytes: 1_383_838,
  sourceUrl: fbUrl,
  uploader: 'Ruben Roach',
});
assert.match(caption, /Example video/);
assert.match(caption, /0:16/);
assert.match(caption, /1\.32MB/);
assert.match(caption, /Ruben Roach/);

assert.equal(policy.canAutoRepostSocialVideoTopic(35), true);
assert.equal(policy.canAutoRepostSocialVideoTopic(36), true);
assert.equal(facebookFallback.facebookUnavailablePageReason({
  title: 'Facebook',
  bodyHint: "This page isn't available at the moment",
}), 'Facebook page unavailable for current session');
assert.equal(facebookFallback.facebookUnavailablePageReason({
  title: 'Facebook',
  bodyHint: 'Video title and creator details',
}), undefined);
assert.equal(facebookFallback.facebookUnavailablePageReason({
  title: 'Facebook',
  bodyHint: 'Log in to view this 18+ content',
}), 'Facebook login/session is required or expired');

const dir = mkdtempSync(path.join(os.tmpdir(), 'zalo-tg-social-video-test-'));
const localPath = path.join(dir, 'video.mp4');
writeFileSync(localPath, 'fixture');
selfVideo.rememberSelfVideoCaption({ msgId: 101 }, caption);
assert.equal(selfVideo.hasSelfVideoCaption('101'), true);
assert.equal(selfVideo.takeSelfVideoCaption('101'), caption);
assert.equal(selfVideo.takeSelfVideoCaption('101'), undefined);
selfVideo.rememberSelfVideoFallback({ msgId: 102 }, localPath, caption);
const fallback = selfVideo.takeSelfVideoFallback('102');
assert.equal(fallback?.caption, caption);
assert.ok(fallback?.localPath && existsSync(fallback.localPath));
store.sentMsgStore.markPendingSelf('zalo-group', 1, 'caption\nhttps://www.threads.com/@creator/post/Dbt7f55kwAc');
assert.equal(store.sentMsgStore.consumePendingSelf('zalo-group', 1, 'caption https://www.threads.com/@creator/post/Dbt7f55kwAc'), true);
assert.equal(store.sentMsgStore.consumePendingSelf('zalo-group', 1, 'caption https://www.threads.com/@creator/post/Dbt7f55kwAc'), false);
rmSync(dir, { recursive: true, force: true });

console.log('social video regression guards ok');

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import assert from 'assert/strict';

const root = mkdtempSync(path.join(tmpdir(), 'zalo-tg-social-queue-'));
process.env.SOCIAL_VIDEO_QUEUE_DIR = root;

const queue = await import('../dist/utils/durableSocialVideoQueue.js');

const first = queue.createDurableSocialVideoJob({
  source: 'telegram',
  target: 'zalo',
  sourceMessageId: 123,
  topicId: 35,
  text: 'https://fb.watch/example',
  url: 'https://fb.watch/example',
  zaloId: 'zalo-room',
  threadType: 1,
});
const second = queue.createDurableSocialVideoJob({
  source: 'telegram',
  target: 'zalo',
  sourceMessageId: 123,
  topicId: 35,
  text: 'https://fb.watch/example',
  url: 'https://fb.watch/example',
  zaloId: 'zalo-room',
  threadType: 1,
});

assert.equal(first.id, second.id);
assert.equal(queue.listReplayableSocialVideoJobs().length, 1);
assert.equal(queue.beginSocialVideoJob(first.id)?.status, 'running');
assert.equal(queue.failSocialVideoJob(first.id, new Error('x'))?.status, 'pending');
assert.equal(queue.beginSocialVideoJob(first.id)?.attempts, 2);
const clientId = queue.socialVideoJobPartClientId(first.id, 0);
assert.match(clientId, /^17\d{11}$/);
const reverse = queue.createDurableSocialVideoJob({
  source: 'zalo',
  target: 'telegram',
  sourceMessageId: 'zalo-456',
  topicId: 35,
  text: 'https://fb.watch/reverse',
  url: 'https://fb.watch/reverse',
  zaloId: 'zalo-room',
  threadType: 1,
});
assert.equal(reverse.source, 'zalo');
assert.equal(reverse.target, 'telegram');
assert.notEqual(reverse.id, first.id);
queue.markSocialVideoJobPartDone(first.id, 0, clientId, { msgId: 'zalo-msg' });
assert.equal(queue.getSocialVideoJob(first.id)?.sentParts?.['0']?.clientId, clientId);
assert.equal(queue.completeSocialVideoJob(first.id)?.status, 'done');

const manifestDir = mkdtempSync(path.join(tmpdir(), 'zalo-tg-social-manifest-'));
const manifestPath = path.join(manifestDir, 'part.mp4');
writeFileSync(manifestPath, 'fixture-part');
const manifest = await queue.buildSocialVideoJobPartManifest([manifestPath]);
assert.equal(manifest[0].sizeBytes, 12);
assert.equal(manifest[0].sha256, createHash('sha256').update('fixture-part').digest('hex'));
assert.equal(queue.setSocialVideoJobPartManifest(reverse.id, [{ index: 0, sizeBytes: 12, sha256: manifest[0].sha256 }])?.partManifest?.[0]?.sha256, manifest[0].sha256);
assert.equal(queue.completeSocialVideoJob(reverse.id)?.status, 'pending');
queue.markSocialVideoJobPartDone(reverse.id, 0, 'telegram-msg-0', { message_id: 1 });
assert.equal(queue.completeSocialVideoJob(reverse.id)?.status, 'done');
assert.equal(queue.listReplayableSocialVideoJobs().length, 0);
assert.equal(queue.hasSocialVideoJobPartManifestMismatch(queue.getSocialVideoJob(reverse.id), [{ index: 0, sizeBytes: 12, sha256: manifest[0].sha256 }, { index: 1, sizeBytes: 12, sha256: manifest[0].sha256 }]), true);
rmSync(manifestDir, { recursive: true, force: true });
rmSync(root, { recursive: true, force: true });
console.log('durable social video queue ok');

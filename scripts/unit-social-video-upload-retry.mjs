import assert from 'node:assert/strict';

const { withUploadRetry } = await import('../dist/utils/socialVideo.js');

let attempts = 0;
const value = await withUploadRetry(async () => {
  attempts += 1;
  if (attempts < 3) throw new Error(`transient failure ${attempts}`);
  return 'uploaded';
}, 'test upload', 3, 0, 100);

assert.equal(value, 'uploaded');
assert.equal(attempts, 3);

let failedAttempts = 0;
await assert.rejects(
  () => withUploadRetry(async () => {
    failedAttempts += 1;
    throw new Error('permanent failure');
  }, 'test permanent upload', 2, 0, 100),
  /permanent failure/,
);
assert.equal(failedAttempts, 2);

console.log('social video upload retry regression guard ok');

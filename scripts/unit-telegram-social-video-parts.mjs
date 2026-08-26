import assert from 'node:assert/strict';
import { telegramPartCountForSize, zaloPartCountForSize } from '../dist/utils/socialVideo.js';

const MiB = 1024 * 1024;
assert.equal(telegramPartCountForSize(45 * MiB), 1);
assert.equal(telegramPartCountForSize(50 * MiB), 1);
assert.equal(telegramPartCountForSize(50 * MiB + 1), 2);
assert.equal(telegramPartCountForSize(90 * MiB), 2);
assert.equal(telegramPartCountForSize(100 * MiB), 3);
assert.equal(zaloPartCountForSize(50 * MiB), 1);
assert.equal(zaloPartCountForSize(50 * MiB + 1), 2);
assert.equal(zaloPartCountForSize(90 * MiB), 2);
console.log('social video multipart guards ok');

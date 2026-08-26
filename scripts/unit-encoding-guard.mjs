import assert from 'assert/strict';
import { readFileSync } from 'fs';

const files = [
  'src/index.ts',
  'src/telegram/handler.ts',
  'src/zalo/handler.ts',
  'src/utils/socialVideo.ts',
];
const text = files.map(file => readFileSync(file, 'utf8')).join('\n');

assert.doesNotMatch(text, /(?:Ã.|Â.|â€|Ä‘|á»|ðŸ|�)/u);
assert.match(text, /Chưa đăng nhập Zalo/u);
assert.match(text, /Không tải được video từ link này\./u);
assert.match(text, /Link này là TikTok photo post/u);

console.log('encoding guard ok');

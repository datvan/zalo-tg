import assert from 'assert/strict';
import { readFileSync } from 'fs';

const files = [
  'src/zalo/handler.ts',
  'src/telegram/handler.ts',
];
const text = files.map(file => readFileSync(file, 'utf8')).join('\n');

assert.match(text, /Kh\u00f4ng t\u1ea3i \u0111\u01b0\u1ee3c video t\u1eeb link n\u00e0y\./u);
assert.match(text, /\u{1f5d1} Tin nh\u1eafn \u0111\u00e3 \u0111\u01b0\u1ee3c thu h\u1ed3i/u);
assert.match(text, /G\u1eedi th\u1ea5t b\u1ea1i/u);
assert.match(text, /Zalo t\u1eeb ch\u1ed1i/u);
assert.doesNotMatch(text, /Kh\?ng t\?i [\?\uFFFD]{1,8}c video t\? link n\?y\./u);
assert.doesNotMatch(text, /Tin nh\u00e1\u00ba\u00afn \u00c4\u2018\u00c3\u00a3 \u00c4\u2018\u00c6\u00b0\u00e1\u00bb\u00a3c thu h\u00e1\u00bb\u201ci/u);

console.log('encoding guard ok');

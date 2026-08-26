import assert from 'assert/strict';
import { readFileSync } from 'fs';

const source = readFileSync(new URL('../src/zalo/handler.ts', import.meta.url), 'utf8');

assert.match(source, /import \{ downloadToTemp, cleanTemp, getVideoInfo \}/);
assert.match(source, /const videoInfo = await getVideoInfo\(partPath\)/);
assert.match(source, /duration: Math\.round\(videoInfo\.durationMs \/ 1000\)/);
assert.match(source, /width: videoInfo\.width/);
assert.match(source, /height: videoInfo\.height/);

console.log('zalo social video metadata wiring ok');

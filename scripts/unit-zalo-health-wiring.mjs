import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guard for the 2026-07 incident: src/zalo/handler.ts silently lost every
// markHealth() call in a live hotpatch (no commit, so `git blame` couldn't find it).
// hasZaloEverWorked/zaloEventAge depend entirely on lastZaloEventAt / lastZaloToTgSuccessAt
// being written from real message traffic — scripts/unit-watchdog-zalo-stale.mjs only tests
// the shouldRestart() decision function with hand-fed fixtures, so it could not (and did
// not) catch the sensor itself going dark. This test asserts the actual source wiring:
// the handler files that are supposed to report traffic really do call markHealth with the
// specific fields the watchdog's staleness detectors read.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '..', 'src');

function read(relPath) {
  return readFileSync(path.join(srcDir, relPath), 'utf8');
}

function assertCallsMarkHealth(source, file, field) {
  const importsMarkHealth = /import\s*\{[^}]*\bmarkHealth\b[^}]*\}\s*from\s*['"][^'"]*health\.js['"]/.test(source);
  assert.ok(importsMarkHealth, `${file} must import markHealth from health.js`);
  const pattern = new RegExp(`markHealth\\(\\{[^}]*\\b${field}\\b[^}]*\\}\\)`);
  assert.ok(pattern.test(source), `${file} must call markHealth({ ${field}: ... }) somewhere — traffic sensor for this field is missing`);
}

const zaloHandler = read('zalo/handler.ts');
assertCallsMarkHealth(zaloHandler, 'src/zalo/handler.ts', 'lastZaloEventAt');
assertCallsMarkHealth(zaloHandler, 'src/zalo/handler.ts', 'lastZaloToTgSuccessAt');

const telegramHandler = read('telegram/handler.ts');
assertCallsMarkHealth(telegramHandler, 'src/telegram/handler.ts', 'lastTelegramUpdateAt');
assertCallsMarkHealth(telegramHandler, 'src/telegram/handler.ts', 'lastTgToZaloSuccessAt');

// The zca-js listener must retry on socket close, and something must observe error/closed/
// disconnected — otherwise a dead websocket is invisible until the (also fallible) timestamp
// heuristics catch it, which is the pre-existing structural gap behind the recurring
// "half-dead" postmortems.
const indexTs = read('index.ts');
assert.ok(/listener\.start\(\s*\{\s*retryOnClose:\s*true/.test(indexTs), 'src/index.ts must start the Zalo listener with retryOnClose: true');
assert.ok(/listener\.on\(\s*['"]error['"]/.test(indexTs), 'src/index.ts must handle listener "error" events');
assert.ok(/listener\.on\(\s*['"]closed['"]/.test(indexTs), 'src/index.ts must handle listener "closed" events');

console.log('unit-zalo-health-wiring: OK');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatGroupMsgHtml } from '../dist/utils/format.js';

const source = readFileSync(new URL('../src/zalo/handler.ts', import.meta.url), 'utf8');

assert.equal(formatGroupMsgHtml('Alice', 'Hello'), '<b>Alice:</b>\nHello');
assert.ok(source.includes('const tgText = formatGroupMsgHtml(senderName, bodyHtml);'));
assert.ok(source.includes('const fullText = `${groupCaption(senderName)}\\n${body}`;'));
assert.ok(source.includes('let nativeSticker = false;'));
assert.ok(source.includes('if (nativeSticker) {'));

console.log('sender name guard ok');

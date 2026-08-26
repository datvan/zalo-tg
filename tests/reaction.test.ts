import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReactionTargetMsgIds } from '../src/zalo/reaction.js';

test('uses cMsgID when Zalo mobile emits gMsgID=0', () => {
  assert.deepEqual(extractReactionTargetMsgIds({
    msgId: 'reaction-event-id',
    cliMsgId: 'reaction-client-id',
    content: { rMsg: [{ gMsgID: 0, cMsgID: 1782286269667 }] },
  }), ['1782286269667']);
});

test('prefers target IDs over outer reaction event IDs', () => {
  assert.deepEqual(extractReactionTargetMsgIds({
    msgId: 'event-global',
    cliMsgId: 'event-client',
    content: { rMsg: [{ gMsgID: 'target-global', cMsgID: 'target-client' }] },
  }), ['target-global', 'target-client']);
});

test('collects every target in a catch-up reaction payload', () => {
  assert.deepEqual(extractReactionTargetMsgIds({
    content: { rMsg: [
      { gMsgID: 'g1', cMsgID: 'c1' },
      { gMsgID: 'g2', cMsgID: 'c2' },
    ] },
  }), ['g1', 'c1', 'g2', 'c2']);
});

test('deduplicates IDs while preserving first-seen order', () => {
  assert.deepEqual(extractReactionTargetMsgIds({
    content: { rMsg: [
      { gMsgID: 'same', cMsgID: 'same' },
      { gMsgID: 'same', cMsgID: 'other' },
    ] },
  }), ['same', 'other']);
});

test('filters zero, blank, null-like and whitespace-only IDs', () => {
  assert.deepEqual(extractReactionTargetMsgIds({
    content: { rMsg: [
      { gMsgID: ' 0 ', cMsgID: '  ' },
      { gMsgID: 0, cMsgID: undefined },
    ] },
  }), []);
});

test('falls back to outer IDs for legacy payloads without rMsg targets', () => {
  assert.deepEqual(extractReactionTargetMsgIds({ msgId: ' m1 ', cliMsgId: 'c1' }), ['m1', 'c1']);
});

test('handles missing payload safely', () => {
  assert.deepEqual(extractReactionTargetMsgIds(undefined), []);
  assert.deepEqual(extractReactionTargetMsgIds(null), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMentionsHtml,
  applyZaloMarkupHtml,
  escapeHtml,
  formatGroupMsg,
  formatGroupMsgHtml,
  groupCaption,
  topicName,
  truncate,
} from '../src/utils/format.js';

function assertStrictlyNestedHtml(html: string): void {
  const stack: string[] = [];
  for (const match of html.matchAll(/<\/?(b|i|u|s)>/g)) {
    const token = match[0];
    const tag = match[1]!;
    if (token.startsWith('</')) {
      assert.equal(stack.pop(), tag, `invalid nesting near ${token} in ${html}`);
    } else {
      stack.push(tag);
    }
  }
  assert.deepEqual(stack, []);
}

function stripSupportedTags(html: string): string {
  return html.replace(/<\/?(?:b|i|u|s)>/g, '');
}

test('truncate leaves short and exact strings unchanged', () => {
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate('abc', 4), 'abc');
});

test('truncate appends an ellipsis within the requested visible length', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(Array.from(truncate('abcdef', 4)).length, 4);
});

test('truncate never splits emoji or combining graphemes', () => {
  assert.equal(truncate('A👨‍👩‍👧‍👦B', 2), 'A…');
  assert.equal(truncate('e\u0301x', 1), '…');
});

test('truncate handles zero and rejects invalid limits', () => {
  assert.equal(truncate('abc', 0), '');
  assert.throws(() => truncate('abc', -1), /non-negative integer/);
  assert.throws(() => truncate('abc', 1.5), /non-negative integer/);
});

test('escapeHtml escapes all Telegram HTML special characters', () => {
  assert.equal(escapeHtml('<a&b>'), '&lt;a&amp;b&gt;');
});

test('applyMentionsHtml sorts mentions and escapes text', () => {
  assert.equal(
    applyMentionsHtml('Hi <An> & Bo', [
      { pos: 10, len: 2, type: 0 },
      { pos: 3, len: 4, type: 0 },
    ]),
    'Hi <b>&lt;An&gt;</b> &amp; <b>Bo</b>',
  );
});

test('applyMentionsHtml ignores empty, overlapping and out-of-range spans', () => {
  assert.equal(
    applyMentionsHtml('abcdef', [
      { pos: 1, len: 3, type: 0 },
      { pos: 2, len: 2, type: 0 },
      { pos: 9, len: 1, type: 0 },
      { pos: 5, len: 0, type: 0 },
    ]),
    'a<b>bcd</b>ef',
  );
});

test('applyZaloMarkupHtml escapes plain text when no supported markup exists', () => {
  assert.equal(applyZaloMarkupHtml('<x>', undefined, [{ start: 0, len: 3, st: 'c_ff0000' }]), '&lt;x&gt;');
});

test('applyZaloMarkupHtml renders nested styles', () => {
  const html = applyZaloMarkupHtml('abcdef', undefined, [
    { start: 0, len: 6, st: 'b' },
    { start: 2, len: 2, st: 'i' },
  ]);
  assert.equal(html, '<b>ab<i>cd</i>ef</b>');
  assertStrictlyNestedHtml(html);
});

test('applyZaloMarkupHtml repairs crossing ranges into valid Telegram HTML', () => {
  const html = applyZaloMarkupHtml('abcdef', undefined, [
    { start: 0, len: 4, st: 'b' },
    { start: 2, len: 4, st: 'i' },
  ]);
  assertStrictlyNestedHtml(html);
  assert.equal(stripSupportedTags(html), 'abcdef');
  assert.match(html, /^<b>ab<i>cd<\/i><\/b><i>ef<\/i>$/);
});

test('applyZaloMarkupHtml safely replaces mention labels', () => {
  const html = applyZaloMarkupHtml(
    'hello @old!',
    [{ pos: 6, len: 4, type: 0, label: '<New & Name>' }],
    [{ start: 0, len: 11, st: 'i' }],
  );
  assertStrictlyNestedHtml(html);
  assert.equal(stripSupportedTags(html), 'hello &lt;New &amp; Name&gt;!');
  assert.match(html, /<b><i>&lt;New &amp; Name&gt;<\/i><\/b>|<i><b>&lt;New &amp; Name&gt;<\/b><\/i>/);
});

test('applyZaloMarkupHtml ignores overlapping mention replacements', () => {
  const html = applyZaloMarkupHtml('abcdef', [
    { pos: 1, len: 4, type: 0, label: 'ONE' },
    { pos: 2, len: 2, type: 0, label: 'TWO' },
  ]);
  assert.equal(html, 'a<b>ONE</b>f');
  assertStrictlyNestedHtml(html);
});

test('group formatting escapes sender and content independently', () => {
  assert.equal(formatGroupMsg('<A>', 'x&y'), '<b>&lt;A&gt;:</b>\nx&amp;y');
  assert.equal(formatGroupMsgHtml('<A>', '<i>x</i>'), '<b>&lt;A&gt;:</b>\n<i>x</i>');
  assert.equal(groupCaption('<A>'), '<b>&lt;A&gt;</b>');
});

test('topicName uses the correct prefix and never breaks a grapheme at 128 chars', () => {
  assert.equal(topicName('Alice', 0), '👤 Alice');
  assert.equal(topicName('Team', 1), '👥 Team');
  const name = topicName('a'.repeat(124) + '👨‍👩‍👧‍👦tail', 1);
  const segments = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name));
  assert.equal(segments.length, 128);
  assert.equal(name.includes('\uFFFD'), false);
});

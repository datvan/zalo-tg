import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

process.env.TG_TOKEN ||= 'test-token';
process.env.TG_GROUP_ID ||= '-1001';
process.env.DATA_DIR = path.join(os.tmpdir(), `zalo-tg-issue47-test-${process.pid}`);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('sanitizes quotes and unsafe filename characters while keeping Unicode', async () => {
  const { sanitizeFileName } = await import('../src/utils/media.js');
  assert.equal(
    sanitizeFileName('Phân công "vội đại"/2026?.pdf'),
    'Phân công _vội đại__2026_.pdf',
  );
});

test('keeps global contact name separate from group-scoped display names', async () => {
  const { userCache } = await import('../src/store.js');
  userCache.save('u47', 'Tên danh bạ');
  userCache.saveForGroup('u47', 'Tên trong nhóm A', 'gA');
  userCache.saveForGroup('u47', 'Tên trong nhóm B', 'gB');
  assert.equal(userCache.getName('u47'), 'Tên danh bạ');
  assert.equal(userCache.getNameInGroup('u47', 'gA'), 'Tên trong nhóm A');
  assert.equal(userCache.getNameInGroup('u47', 'gB'), 'Tên trong nhóm B');
});

test('keeps echo suppression active until every concurrent send finishes', async () => {
  const { sentMsgStore } = await import('../src/store.js');
  sentMsgStore.markSending('concurrent-thread');
  sentMsgStore.markSending('concurrent-thread');
  sentMsgStore.unmarkSending('concurrent-thread');
  assert.equal(sentMsgStore.isSendingTo('concurrent-thread'), true);
  sentMsgStore.unmarkSending('concurrent-thread');
  assert.equal(sentMsgStore.isSendingTo('concurrent-thread'), false);
});

test('keeps a trailing single photo out of sendMediaGroup', async () => {
  const { telegramMediaBatches } = await import('../src/utils/media.js');
  const batches = telegramMediaBatches(Array.from({ length: 11 }, (_, i) => i + 1));
  assert.deepEqual(batches.map(batch => batch.length), [10, 1]);
  assert.deepEqual(telegramMediaBatches(['only-one']), [['only-one']]);
});

test('groups Zalo photos even when every childnumber is zero and preserves order', async () => {
  const { zaloAlbumStore } = await import('../src/store.js');
  const flushed: Array<{ items: Array<{ url: string; msgIds: string[] }> }> = [];
  const meta = {
    senderName: 'Tester',
    topicId: 47,
    tgBase: { message_thread_id: 47 },
    zaloQuote: undefined,
  };
  for (const [url, id] of [['url-1', 'm1'], ['url-2', 'm2'], ['url-3', 'm3']] as const) {
    zaloAlbumStore.add('g:u', url, [id], undefined, meta, buf => { flushed.push(buf); }, 0);
  }
  await sleep(750);
  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0]!.items.map(item => item.url), ['url-1', 'url-2', 'url-3']);
});

test('deduplicates a repeated Zalo photo URL but retains all message ids', async () => {
  const { zaloAlbumStore } = await import('../src/store.js');
  let result: { items: Array<{ url: string; msgIds: string[] }> } | undefined;
  const meta = {
    senderName: 'Tester',
    topicId: 48,
    tgBase: { message_thread_id: 48 },
    zaloQuote: undefined,
  };
  zaloAlbumStore.add('g:u:dup', 'same-url', ['m1'], undefined, meta, buf => { result = buf; }, 0);
  zaloAlbumStore.add('g:u:dup', 'same-url', ['m2'], undefined, meta, buf => { result = buf; }, 0);
  await sleep(750);
  assert.equal(result?.items.length, 1);
  assert.deepEqual(result?.items[0]?.msgIds, ['m1', 'm2']);
});

test('keeps fallback CDN URLs when duplicate Zalo photo events are merged', async () => {
  const { zaloAlbumStore } = await import('../src/store.js');
  let result: { items: Array<{ url: string; fallbackUrls: string[] }> } | undefined;
  const meta = {
    senderName: 'Tester',
    topicId: 481,
    tgBase: { message_thread_id: 481 },
    zaloQuote: undefined,
  };
  zaloAlbumStore.add('g:u:fallback', 'hd-url', ['m1'], undefined, meta, buf => { result = buf; }, 0, ['normal-url']);
  zaloAlbumStore.add('g:u:fallback', 'hd-url', ['m2'], undefined, meta, buf => { result = buf; }, 0, ['thumb-url']);
  await sleep(750);
  assert.deepEqual(result?.items[0]?.fallbackUrls, ['normal-url', 'thumb-url']);
});

test('deduplicates renewed HD URLs when two Zalo events share a normal CDN URL', async () => {
  const { zaloAlbumStore } = await import('../src/store.js');
  let result: { items: Array<{ url: string; fallbackUrls: string[]; msgIds: string[] }> } | undefined;
  const meta = {
    senderName: 'Tester',
    topicId: 482,
    tgBase: { message_thread_id: 482 },
    zaloQuote: undefined,
  };
  zaloAlbumStore.add('g:u:renewed', 'hd-old', ['m1'], undefined, meta, buf => { result = buf; }, 0, ['normal']);
  zaloAlbumStore.add('g:u:renewed', 'hd-new', ['m2'], undefined, meta, buf => { result = buf; }, 0, ['normal']);
  await sleep(750);
  assert.equal(result?.items.length, 1);
  assert.deepEqual(result?.items[0]?.msgIds, ['m1', 'm2']);
  assert.deepEqual(result?.items[0]?.fallbackUrls, ['normal', 'hd-new']);
});

test('waits for delayed Telegram video update before flushing one media group', async () => {
  const { mediaGroupStore } = await import('../src/store.js');
  const batches: Array<Array<{ fileId: string }>> = [];
  const meta = { topicId: 49, zaloId: 'z49', threadType: 1 as const };
  mediaGroupStore.add('tg-album', { fileId: 'photo', fname: 'p.jpg' }, meta, items => { batches.push(items); });
  await sleep(300);
  mediaGroupStore.add('tg-album', { fileId: 'video', fname: 'v.mp4', isVideo: true }, meta, items => { batches.push(items); });
  await sleep(1_100);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]!.map(item => item.fileId), ['photo', 'video']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ThreadType } from 'zca-js';

process.env.TG_TOKEN ||= 'test-token';
process.env.TG_GROUP_ID ||= '-1001';
process.env.DATA_DIR = path.join(os.tmpdir(), `zalo-tg-autoreply-test-${process.pid}-${Date.now()}`);

const { sentMsgStore } = await import('../src/store.js');
const {
  getAutoReplyState,
  maybeAutoReply,
  setAutoReplyEnabled,
} = await import('../src/zalo/autoReply.js');

await test('auto-reply persists configuration and only answers eligible DMs', async () => {
  setAutoReplyEnabled(true, 'Tôi đang bận');
  assert.deepEqual(getAutoReplyState(), { enabled: true, message: 'Tôi đang bận' });
  const persisted = JSON.parse(await readFile(path.join(process.env.DATA_DIR!, 'autoreply.json'), 'utf8'));
  assert.deepEqual(persisted, { enabled: true, message: 'Tôi đang bận' });

  let sends = 0;
  const api = {
    async sendMessage(payload: { msg: string }) {
      sends++;
      assert.deepEqual(payload, { msg: 'Tôi đang bận' });
      return { message: { msgId: 'auto-reply-zalo-id' } };
    },
  };

  const originalSetTimeout = globalThis.setTimeout;
  const originalRandom = Math.random;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  Math.random = () => 0;
  try {
    assert.equal(await maybeAutoReply(api as never, 'group-thread', ThreadType.Group), false);
    assert.equal(await maybeAutoReply(api as never, 'dm-thread', ThreadType.User), true);
    assert.equal(await maybeAutoReply(api as never, 'dm-thread', ThreadType.User), false, 'peer cooldown');
    assert.equal(sends, 1);
    const syntheticTgId = sentMsgStore.getByZaloMsgId('auto-reply-zalo-id');
    assert.equal(typeof syntheticTgId, 'number');
    assert.ok(syntheticTgId! < 0);
    assert.equal(sentMsgStore.isSendingTo('dm-thread'), false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    Math.random = originalRandom;
    setAutoReplyEnabled(false);
  }
});

test('auto-reply releases the in-flight marker after a failed send', async () => {
  setAutoReplyEnabled(true, 'busy');
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    const failed = await maybeAutoReply({
      async sendMessage() { throw new Error('network down'); },
    } as never, 'dm-failure', ThreadType.User);
    assert.equal(failed, false);
    assert.equal(sentMsgStore.isSendingTo('dm-failure'), false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    setAutoReplyEnabled(false);
  }
});

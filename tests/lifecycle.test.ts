import test from 'node:test';
import assert from 'node:assert/strict';
import { registerShutdownHandler, requestShutdown } from '../src/lifecycle.js';

test('requestShutdown is idempotent and preserves the first reason/code', async () => {
  let calls = 0;
  let received: [string, number] | undefined;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });

  registerShutdownHandler(async (reason, exitCode) => {
    calls++;
    received = [reason, exitCode];
    await gate;
  });

  const first = requestShutdown('first', 42);
  const second = requestShutdown('second', 99);
  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.deepEqual(received, ['first', 42]);
  release();
  await first;
});

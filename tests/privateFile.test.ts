import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { writePrivateJsonFileSync, writePrivateTextFileSync } from '../src/utils/privateFile.js';

test('private file writer creates parent directories and writes exact content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zalo-private-file-'));
  const target = path.join(root, 'nested', 'secret.txt');
  writePrivateTextFileSync(target, 'secret');
  assert.equal(await readFile(target, 'utf8'), 'secret');

  if (process.platform !== 'win32') {
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  }
});

test('private JSON writer produces readable formatted JSON', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zalo-private-json-'));
  const target = path.join(root, 'session.json');
  writePrivateJsonFileSync(target, { token: 'x', nested: { ok: true } });
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), {
    token: 'x',
    nested: { ok: true },
  });
});

import assert from 'node:assert/strict';
import { resolveTopicDisplayName } from '../dist/zalo/topic.js';

const name = resolveTopicDisplayName({
  type: 0,
  zaloId: 'customer-id',
  senderName: 'Logged-in Zalo account',
  isSelf: true,
  profile: { displayName: 'Kỹ Thuật Difas' },
});

assert.equal(name, 'Kỹ Thuật Difas');
assert.equal(resolveTopicDisplayName({
  type: 0,
  zaloId: 'customer-id',
  senderName: 'Logged-in Zalo account',
  isSelf: true,
}), 'Zalo customer-id');
assert.equal(resolveTopicDisplayName({
  type: 0,
  zaloId: 'customer-id',
  senderName: 'Kỹ Thuật Difas',
  isSelf: false,
}), 'Kỹ Thuật Difas');
assert.equal(resolveTopicDisplayName({
  type: 1,
  zaloId: 'group-id',
  senderName: 'Group sender',
  isSelf: true,
  profile: { displayName: 'Wrong profile' },
}), 'Group sender');
console.log('unit-topic-name: OK');

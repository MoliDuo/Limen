import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLoginAttemptKey,
  readBearerToken,
  secureStringEqual,
} from '@/lib/auth/security';

test('secureStringEqual compares strings only', () => {
  assert.equal(secureStringEqual('same', 'same'), true);
  assert.equal(secureStringEqual('short', 'longer'), false);
  assert.equal(secureStringEqual(undefined, 'x'), false);
});

test('Bearer tokens are read from the Authorization header', () => {
  assert.equal(readBearerToken('Bearer limen_a.b'), 'limen_a.b');
  assert.equal(readBearerToken('Basic abc'), null);
  assert.equal(readBearerToken(null), null);
});

test('login identifiers are hashed and stable', () => {
  const first = createLoginAttemptKey('203.0.113.1, 10.0.0.1');
  assert.equal(first, createLoginAttemptKey('203.0.113.1'));
  assert.notEqual(first, createLoginAttemptKey('203.0.113.2'));
  assert.doesNotMatch(first, /203\.0\.113/);
  assert.equal(createLoginAttemptKey(null), createLoginAttemptKey(''));
});

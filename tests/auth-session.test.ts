import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  destroySession,
  readSession,
  renewSession,
  sessionCookieOptions,
  SESSION_DURATION_SECONDS,
} from '@/lib/auth/session';
import { unlockWithPassword } from '@/lib/crypto/key-slots';
import { createTestDb } from './helpers/test-db';
import { testDataKey, TEST_PASSWORD } from './helpers/test-password';

const cleanups: Array<() => Promise<void>> = [];
test.after(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
});

test('a session cookie opens its own slot until it is destroyed', async () => {
  const fixture = await createTestDb();
  const { db } = fixture;
  cleanups.push(fixture.cleanup);
  const dataKey = await testDataKey(db);
  const now = new Date();
  const { token, expiresAt } = await createSession(db, dataKey, now);

  assert.equal(
    expiresAt.getTime(),
    now.getTime() + SESSION_DURATION_SECONDS * 1_000,
  );
  // The cookie carries no password material.
  assert.equal(token.includes(TEST_PASSWORD), false);
  const session = await readSession(db, token, now);
  assert.ok(session);
  assert.equal(session.expiresAt.getTime(), expiresAt.getTime());

  assert.equal(await readSession(db, 'invalid', now), null);
  assert.equal(await readSession(db, undefined, now), null);
  assert.equal(
    await readSession(db, `${session.id}.${'A'.repeat(43)}`, now),
    null,
  );

  await destroySession(db, token);
  assert.equal(await readSession(db, token, now), null);
  // The password slot is untouched.
  assert.ok(await unlockWithPassword(db, TEST_PASSWORD));
});

test('an expired session is refused and renewal extends it in the database', async () => {
  const fixture = await createTestDb();
  const { db } = fixture;
  cleanups.push(fixture.cleanup);
  const dataKey = await testDataKey(db);
  const start = new Date('2026-09-01T00:00:00.000Z');
  const { token } = await createSession(db, dataKey, start);
  const later = new Date(
    start.getTime() + (SESSION_DURATION_SECONDS - 60) * 1_000,
  );
  const session = await readSession(db, token, later);
  assert.ok(session);

  const renewed = await renewSession(db, session, later);
  assert.ok(renewed > session.expiresAt);
  const afterOriginalExpiry = new Date(
    start.getTime() + (SESSION_DURATION_SECONDS + 60) * 1_000,
  );
  assert.ok(await readSession(db, token, afterOriginalExpiry));
  assert.equal(
    await readSession(db, token, new Date(renewed.getTime() + 1_000)),
    null,
  );
});

test('session cookies use strict production-oriented attributes', () => {
  const expires = new Date('2024-02-01T00:00:00.000Z');
  const options = sessionCookieOptions(expires);
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, 'strict');
  assert.equal(options.path, '/');
  assert.equal(options.priority, 'high');
  assert.equal(SESSION_DURATION_SECONDS, 7 * 24 * 60 * 60);
});

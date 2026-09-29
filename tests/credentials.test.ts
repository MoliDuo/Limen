import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptionKeySlots } from '@/lib/db/schema';
import {
  countKeySlots,
  createCredentialSlot,
  listApiTokens,
  unlockWithPassword,
} from '@/lib/crypto/key-slots';
import {
  API_TOKEN_PREFIX,
  formatCredential,
  parseCredential,
  verifyCredential,
} from '@/lib/auth/credentials';
import { authorizeApiRequest } from '@/lib/auth/security';
import { createSession, readSession } from '@/lib/auth/session';
import { unlockForLogin } from '@/lib/auth/login-unlock';
import { createSecurityActions } from '@/lib/security-core';
import type { AppDatabase } from '@/lib/db';
import { createTestDb } from './helpers/test-db';
import { testDataKey, TEST_PASSWORD } from './helpers/test-password';

const cleanups: Array<() => Promise<void>> = [];
test.after(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
});

async function freshDb() {
  const fixture = await createTestDb();
  cleanups.push(fixture.cleanup);
  return fixture.db as unknown as AppDatabase;
}

function form(values: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return formData;
}

function securityActions(
  db: AppDatabase,
  current: { sessionId: string; dataKey: Buffer },
) {
  let failures = 0;
  return createSecurityActions({
    db,
    authorize: async () => current,
    getRateLimit: async () => ({
      blocked: failures >= 5,
      retryAfterSeconds: failures >= 5 ? 900 : 0,
    }),
    recordFailure: async () => {
      failures += 1;
      return { blocked: failures >= 5, retryAfterSeconds: 900 };
    },
    clearFailures: async () => {
      failures = 0;
    },
    revalidatePath: () => {},
  });
}

function bearer(token: string) {
  return new Request('http://localhost/api/entries', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

test('credentials parse only in their own format', () => {
  assert.deepEqual(parseCredential('session', 'abc.def'), {
    id: 'abc',
    secret: 'def',
  });
  assert.equal(parseCredential('session', 'abc'), null);
  assert.equal(parseCredential('session', 'a.b.c'), null);
  assert.equal(parseCredential('api_token', 'abc.def'), null);
  const token = formatCredential('api_token', 'abc', 'def');
  assert.ok(token.startsWith(API_TOKEN_PREFIX));
  assert.deepEqual(parseCredential('api_token', token), {
    id: 'abc',
    secret: 'def',
  });
});

test('each credential opens its own slot and nothing else', async () => {
  const db = await freshDb();
  const dataKey = await testDataKey(db);
  const session = await createCredentialSlot(db, dataKey, 'session', {
    expiresAt: new Date(Date.now() + 60_000),
  });
  const token = await createCredentialSlot(db, dataKey, 'api_token', {
    label: 'phone',
  });

  const opened = await verifyCredential(
    db,
    'api_token',
    formatCredential('api_token', token.id, token.secret),
  );
  assert.deepEqual(opened?.dataKey, dataKey);

  // A session secret is not an API token, even with the prefix added.
  assert.equal(
    await verifyCredential(
      db,
      'api_token',
      formatCredential('api_token', session.id, session.secret),
    ),
    null,
  );
  // Another slot's secret does not open this one.
  assert.equal(
    await verifyCredential(
      db,
      'api_token',
      formatCredential('api_token', token.id, session.secret),
    ),
    null,
  );
  // Nothing secret is stored: the database only has the wrapped key.
  const rows = await db.select().from(encryptionKeySlots);
  const stored = JSON.stringify(rows);
  assert.equal(stored.includes(token.secret), false);
  assert.equal(stored.includes(session.secret), false);
  assert.equal(stored.includes(TEST_PASSWORD), false);
});

test('an expired session does not open, even from the cache', async () => {
  const db = await freshDb();
  const now = new Date('2026-09-21T00:00:00.000Z');
  const { token, expiresAt } = await createSession(
    db,
    await testDataKey(db),
    now,
  );
  assert.ok(await readSession(db, token, now));
  assert.equal(
    await readSession(db, token, new Date(expiresAt.getTime() + 1)),
    null,
  );
});

test('API tokens authorize requests until revoked, and record use', async () => {
  const db = await freshDb();
  const dataKey = await testDataKey(db);
  const actions = securityActions(db, { sessionId: 'none', dataKey });

  const created = await actions.createApiToken(
    undefined,
    form({ label: 'iPhone 快捷指令' }),
  );
  assert.ok(created.ok);
  const { id, token } = created.data;

  assert.equal(await authorizeApiRequest(bearer(token), db), true);
  assert.equal(await authorizeApiRequest(bearer(`${token}x`), db), false);
  assert.equal(
    await authorizeApiRequest(new Request('http://localhost/'), db),
    false,
  );
  const [listed] = await listApiTokens(db);
  assert.equal(listed.label, 'iPhone 快捷指令');
  assert.ok(listed.lastUsedAt);

  assert.deepEqual(await actions.revokeApiToken(id), {
    ok: true,
    data: undefined,
  });
  // Cached a moment ago, refused now: revoking clears this instance's cache.
  assert.equal(await authorizeApiRequest(bearer(token), db), false);
  assert.equal((await actions.revokeApiToken(id)).ok, false);
});

test('token labels are required and bounded', async () => {
  const db = await freshDb();
  const actions = securityActions(db, {
    sessionId: 'none',
    dataKey: await testDataKey(db),
  });
  assert.equal(
    (await actions.createApiToken(undefined, form({ label: '  ' }))).ok,
    false,
  );
  assert.equal(
    (await actions.createApiToken(undefined, form({ label: 'x'.repeat(61) })))
      .ok,
    false,
  );
  assert.deepEqual(await listApiTokens(db), []);
});

test('changing the password keeps this device and API tokens, signs out the rest', async () => {
  const db = await freshDb();
  const dataKey = await testDataKey(db);
  const mine = await createSession(db, dataKey);
  const other = await createSession(db, dataKey);
  const token = await createCredentialSlot(db, dataKey, 'api_token', {
    label: 'phone',
  });
  const mySession = await readSession(db, mine.token);
  assert.ok(mySession);
  // Warm the cache for the session that is about to be revoked.
  assert.ok(await readSession(db, other.token));

  const actions = securityActions(db, { sessionId: mySession.id, dataKey });
  const newPassword = 'a-brand-new-password';

  const wrong = await actions.changePassword(
    undefined,
    form({
      currentPassword: 'not-it',
      newPassword,
      confirmPassword: newPassword,
    }),
  );
  assert.deepEqual(wrong, {
    ok: false,
    error: '当前密码不正确',
    retryAfterSeconds: undefined,
  });
  assert.equal(
    (
      await actions.changePassword(
        undefined,
        form({
          currentPassword: TEST_PASSWORD,
          newPassword: 'short',
          confirmPassword: 'short',
        }),
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await actions.changePassword(
        undefined,
        form({
          currentPassword: TEST_PASSWORD,
          newPassword,
          confirmPassword: `${newPassword}!`,
        }),
      )
    ).ok,
    false,
  );

  assert.deepEqual(
    await actions.changePassword(
      undefined,
      form({
        currentPassword: TEST_PASSWORD,
        newPassword,
        confirmPassword: newPassword,
      }),
    ),
    { ok: true, data: undefined },
  );

  assert.equal(await unlockWithPassword(db, TEST_PASSWORD), null);
  assert.deepEqual(
    (await unlockWithPassword(db, newPassword))?.dataKey,
    dataKey,
  );
  assert.ok(await readSession(db, mine.token));
  assert.equal(await readSession(db, other.token), null);
  assert.ok(
    await verifyCredential(
      db,
      'api_token',
      formatCredential('api_token', token.id, token.secret),
    ),
  );
  assert.deepEqual(await countKeySlots(db), {
    password: 1,
    session: 1,
    api_token: 1,
  });
});

test('repeated wrong current passwords are throttled', async () => {
  const db = await freshDb();
  const actions = securityActions(db, {
    sessionId: 's',
    dataKey: await testDataKey(db),
  });
  const attempt = () =>
    actions.changePassword(
      undefined,
      form({
        currentPassword: 'guess',
        newPassword: 'a-brand-new-password',
        confirmPassword: 'a-brand-new-password',
      }),
    );
  for (let i = 0; i < 5; i += 1) await attempt();
  const blocked = await attempt();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok ? 0 : blocked.retryAfterSeconds, 900);
});

test('login accepts the old AUTH_PASSWORD only to set up a database with no password', async () => {
  const empty = await freshDb();
  assert.equal(
    await unlockForLogin('anything', empty, undefined),
    'uninitialized',
  );
  assert.equal(await unlockForLogin('wrong', empty, 'legacy-password'), null);
  assert.equal((await countKeySlots(empty)).password, 0);

  const key = await unlockForLogin('legacy-password', empty, 'legacy-password');
  assert.ok(Buffer.isBuffer(key));
  assert.equal((await countKeySlots(empty)).password, 1);

  // Once a password slot exists, the variable no longer matters.
  const db = await freshDb();
  await testDataKey(db);
  assert.equal(
    await unlockForLogin('legacy-password', db, 'legacy-password'),
    null,
  );
  assert.ok(
    Buffer.isBuffer(await unlockForLogin(TEST_PASSWORD, db, undefined)),
  );
});

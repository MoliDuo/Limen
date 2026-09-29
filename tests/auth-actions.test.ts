import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuthActions,
  UNINITIALIZED_MESSAGE,
  type UnlockResult,
} from '@/lib/auth/action-core';

const DATA_KEY = Buffer.alloc(32, 7);

function dependencies(
  overrides: Partial<Parameters<typeof createAuthActions>[0]> = {},
) {
  const cookieWrites: string[] = [];
  const sessionKeys: Buffer[] = [];
  let destroyed = 0;
  return {
    cookieWrites,
    sessionKeys,
    destroyed: () => destroyed,
    actions: createAuthActions({
      unlock: async (password): Promise<UnlockResult> =>
        password === 'correct-password-value' ? DATA_KEY : null,
      getRateLimit: async () => ({ blocked: false, retryAfterSeconds: 0 }),
      recordFailure: async () => ({
        blocked: false,
        retryAfterSeconds: 0,
        failures: 1,
      }),
      clearFailures: async () => {},
      createSession: async (dataKey) => {
        sessionKeys.push(dataKey);
        return { token: 'session-token', expiresAt: new Date(0) };
      },
      setSessionCookie: async (token) => {
        cookieWrites.push(token);
      },
      destroySession: async () => {
        destroyed += 1;
      },
      clearSessionCookie: async () => {
        cookieWrites.push('cleared');
      },
      ...overrides,
    }),
  };
}

function passwordForm(password: string) {
  const formData = new FormData();
  formData.set('password', password);
  return formData;
}

test('login opens a session with the key the password unlocked', async () => {
  const { actions, cookieWrites, sessionKeys } = dependencies();
  assert.deepEqual(
    await actions.login(passwordForm('correct-password-value'), 'client'),
    { ok: true, data: undefined },
  );
  assert.deepEqual(cookieWrites, ['session-token']);
  assert.deepEqual(sessionKeys, [DATA_KEY]);
});

test('login records invalid passwords without setting a cookie', async () => {
  let failures = 0;
  const { actions, cookieWrites } = dependencies({
    recordFailure: async () => {
      failures += 1;
      return { blocked: false, retryAfterSeconds: 0, failures };
    },
  });
  const result = await actions.login(passwordForm('wrong'), 'client');
  assert.equal(result.ok, false);
  assert.equal(failures, 1);
  assert.deepEqual(cookieWrites, []);
});

test('login does not try an empty or missing password', async () => {
  let unlocked = 0;
  const { actions } = dependencies({
    unlock: async () => {
      unlocked += 1;
      return DATA_KEY;
    },
  });
  assert.equal((await actions.login(new FormData(), 'client')).ok, false);
  assert.equal((await actions.login(passwordForm(''), 'client')).ok, false);
  assert.equal(unlocked, 0);
});

test('login rejects blocked clients before trying the password', async () => {
  let unlocked = false;
  const { actions } = dependencies({
    getRateLimit: async () => ({ blocked: true, retryAfterSeconds: 120 }),
    unlock: async () => {
      unlocked = true;
      return DATA_KEY;
    },
  });
  const result = await actions.login(passwordForm('x'), 'blocked-client');
  assert.deepEqual(result, {
    ok: false,
    error: '密码错误或请求过于频繁',
    retryAfterSeconds: 120,
  });
  assert.equal(unlocked, false);
});

test('login explains how to set up a database with no password', async () => {
  let failures = 0;
  const { actions } = dependencies({
    unlock: async () => 'uninitialized',
    recordFailure: async () => {
      failures += 1;
      return { blocked: false, retryAfterSeconds: 0, failures };
    },
  });
  assert.deepEqual(await actions.login(passwordForm('anything'), 'client'), {
    ok: false,
    error: UNINITIALIZED_MESSAGE,
  });
  assert.equal(failures, 0);
});

test('logout ends the session and clears the cookie', async () => {
  const { actions, cookieWrites, destroyed } = dependencies();
  assert.deepEqual(await actions.logout(), { ok: true, data: undefined });
  assert.equal(destroyed(), 1);
  assert.deepEqual(cookieWrites, ['cleared']);
});

'use server';

import { after } from 'next/server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import type { ActionResult } from '@/lib/actions/result';
import { messages } from '@/lib/messages';
import { createAuthActions } from './action-core';
import { createLoginAttemptKey } from './security';
import { unlockForLogin } from './login-unlock';
import {
  createSession,
  destroySession,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from './session';
import { deleteExpiredSessions } from '@/lib/crypto/key-slots';
import { purgeExpiredEntries } from '@/lib/trash/purge';
import {
  cleanupLoginAttempts,
  clearLoginFailures,
  getLoginRateLimit,
  recordLoginFailure,
} from './rate-limit';

async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(
    SESSION_COOKIE_NAME,
    token,
    sessionCookieOptions(expiresAt),
  );
}

async function clearSessionCookie() {
  (await cookies()).set(
    SESSION_COOKIE_NAME,
    '',
    sessionCookieOptions(new Date(0)),
  );
}

const authActions = createAuthActions({
  unlock: (password) => unlockForLogin(password),
  getRateLimit: getLoginRateLimit,
  recordFailure: recordLoginFailure,
  clearFailures: clearLoginFailures,
  createSession: (dataKey) => createSession(db, dataKey),
  setSessionCookie,
  destroySession: async () =>
    destroySession(db, (await cookies()).get(SESSION_COOKIE_NAME)?.value),
  clearSessionCookie,
});

export async function handleLoginAttempt(
  attempt: () => Promise<ActionResult>,
  reportError: (error: unknown) => void = (error) =>
    console.error('Login action failed:', error),
): Promise<ActionResult> {
  try {
    return await attempt();
  } catch (error) {
    reportError(error);
    return { ok: false, error: messages.login.unexpectedError };
  }
}

export async function login(
  _previousState: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const result = await handleLoginAttempt(async () => {
    const requestHeaders = await headers();
    const forwardedFor =
      requestHeaders.get('x-vercel-forwarded-for') ??
      requestHeaders.get('x-forwarded-for');
    const loginResult = await authActions.login(
      formData,
      createLoginAttemptKey(forwardedFor),
    );
    after(() => cleanupLoginAttempts());
    after(() => deleteExpiredSessions(db));
    // Guarantees the 30-day sweep eventually happens even if the owner never
    // opens the recycle bin, without a cron dependency. Deliberately not on
    // every timeline read: a day's delay is harmless, a DELETE per page load
    // is not.
    after(() => purgeExpiredEntries());
    return loginResult;
  });
  if (!result.ok) return result;
  redirect('/');
}

export async function logout() {
  return authActions.logout();
}

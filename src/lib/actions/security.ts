'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { verifyCredential } from '@/lib/auth/credentials';
import { SESSION_COOKIE_NAME, UnauthorizedError } from '@/lib/auth/session';
import {
  clearLoginFailures,
  getLoginRateLimit,
  recordLoginFailure,
} from '@/lib/auth/rate-limit';
import { createSecurityActions } from '@/lib/security-core';

/** Browser sessions only: an API token cannot mint tokens or change the password. */
async function authorize() {
  const session = await verifyCredential(
    db,
    'session',
    (await cookies()).get(SESSION_COOKIE_NAME)?.value,
  );
  if (!session) throw new UnauthorizedError();
  return { sessionId: session.slotId, dataKey: session.dataKey };
}

const securityActions = createSecurityActions({
  db,
  authorize,
  getRateLimit: getLoginRateLimit,
  recordFailure: recordLoginFailure,
  clearFailures: clearLoginFailures,
  revalidatePath,
});

export const changePassword = securityActions.changePassword;
export const createApiToken = securityActions.createApiToken;
export const revokeApiToken = securityActions.revokeApiToken;

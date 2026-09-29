import { cookies } from 'next/headers';
import { db, type AppDatabase } from '@/lib/db';
import {
  createCredentialSlot,
  deleteCredentialSlot,
  updateCredentialSlot,
} from '@/lib/crypto/key-slots';
import {
  forgetCredentials,
  formatCredential,
  verifyCredential,
} from '@/lib/auth/credentials';

/**
 * Sessions are key slots (lib/crypto/key-slots.ts): the cookie holds the only
 * copy of the secret that opens the session's wrapped data key. Signing out
 * or changing the password deletes the slot, which ends the session on every
 * instance within a minute (see the cache in lib/auth/credentials.ts).
 */

export const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60;
/**
 * Extend a session once it has less than this left.
 *
 * Without renewal the cookie is a hard 7-day timer, so someone writing every
 * day still gets logged out every week for no reason. Renewing only in the
 * last third keeps the number of writes low.
 */
export const SESSION_RENEW_THRESHOLD_SECONDS = 3 * 24 * 60 * 60;

export const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === 'production'
    ? '__Host-limen-session'
    : 'limen-session';

export type Session = { id: string; expiresAt: Date };

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export function shouldRenewSession(
  session: Session | null | undefined,
  now = new Date(),
) {
  if (!session) return false;
  const remaining = session.expiresAt.getTime() - now.getTime();
  return remaining > 0 && remaining < SESSION_RENEW_THRESHOLD_SECONDS * 1_000;
}

export function sessionExpiry(now = new Date()) {
  return new Date(now.getTime() + SESSION_DURATION_SECONDS * 1_000);
}

export function sessionCookieOptions(expires: Date) {
  return {
    expires,
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    priority: 'high' as const,
  };
}

/** Returns the cookie value; the secret in it is stored nowhere else. */
export async function createSession(
  database: AppDatabase,
  dataKey: Buffer,
  now = new Date(),
) {
  const expiresAt = sessionExpiry(now);
  const { id, secret } = await createCredentialSlot(
    database,
    dataKey,
    'session',
    { expiresAt },
  );
  return { token: formatCredential('session', id, secret), expiresAt };
}

export async function readSession(
  database: AppDatabase,
  token: string | null | undefined,
  now = new Date(),
): Promise<Session | null> {
  const credential = await verifyCredential(database, 'session', token, now);
  if (!credential?.expiresAt) return null;
  return { id: credential.slotId, expiresAt: credential.expiresAt };
}

export async function getSession(database: AppDatabase = db) {
  return readSession(
    database,
    (await cookies()).get(SESSION_COOKIE_NAME)?.value,
  );
}

export async function requireSession(database: AppDatabase = db) {
  const session = await getSession(database);
  if (!session) throw new UnauthorizedError();
  return session;
}

/** Slides the expiry forward; the cookie keeps the same value. */
export async function renewSession(
  database: AppDatabase,
  session: Session,
  now = new Date(),
) {
  const expiresAt = sessionExpiry(now);
  await updateCredentialSlot(database, session.id, { expiresAt });
  forgetCredentials(database, [session.id]);
  return expiresAt;
}

export async function destroySession(
  database: AppDatabase,
  token: string | null | undefined,
) {
  const session = await readSession(database, token);
  if (!session) return;
  await deleteCredentialSlot(database, 'session', session.id);
  forgetCredentials(database, [session.id]);
}

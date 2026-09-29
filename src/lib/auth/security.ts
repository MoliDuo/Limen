import { createHash, timingSafeEqual } from 'node:crypto';
import { db, type AppDatabase } from '@/lib/db';
import { updateCredentialSlot } from '@/lib/crypto/key-slots';
import { verifyCredential } from '@/lib/auth/credentials';

export function secureStringEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function readBearerToken(header: string | null) {
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/** Recording every call would be a write per request for no benefit. */
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1_000;

/** API clients authenticate with a token issued on the settings page. */
export async function authorizeApiRequest(
  request: Request,
  database: AppDatabase = db,
  now = new Date(),
) {
  const credential = await verifyCredential(
    database,
    'api_token',
    readBearerToken(request.headers.get('authorization')),
    now,
  );
  if (!credential) return false;
  if (
    !credential.lastUsedAt ||
    now.getTime() - credential.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS
  ) {
    await updateCredentialSlot(database, credential.slotId, {
      lastUsedAt: now,
    });
    credential.lastUsedAt = now;
  }
  return true;
}

/**
 * Hashed so auth_attempts does not hold raw addresses. There is no server
 * secret to key this with any more; anyone holding the database could
 * enumerate IPv4 space against it, which is why the rows are short-lived.
 */
export function createLoginAttemptKey(forwardedFor: string | null) {
  const clientAddress =
    forwardedFor?.split(',')[0]?.trim().slice(0, 128) || 'unknown';
  return createHash('sha256')
    .update(`limen/login-attempt/${clientAddress}`)
    .digest('base64url');
}

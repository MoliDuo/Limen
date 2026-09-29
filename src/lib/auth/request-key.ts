import { cookies, headers } from 'next/headers';
import type { AppDatabase } from '@/lib/db';
import { verifyCredential } from '@/lib/auth/credentials';
import { SESSION_COOKIE_NAME, UnauthorizedError } from '@/lib/auth/session';
import { readBearerToken } from '@/lib/auth/security';

/**
 * The data key for this request, opened with the credential it carries: the
 * session cookie in the browser, the Bearer token from an API client. The
 * default source behind getFieldCipher (lib/crypto/cipher.ts).
 */
export async function requestDataKey(database: AppDatabase) {
  const session = await verifyCredential(
    database,
    'session',
    (await cookies()).get(SESSION_COOKIE_NAME)?.value,
  );
  if (session) return session.dataKey;

  const token = await verifyCredential(
    database,
    'api_token',
    readBearerToken((await headers()).get('authorization')),
  );
  if (token) return token.dataKey;

  throw new UnauthorizedError();
}

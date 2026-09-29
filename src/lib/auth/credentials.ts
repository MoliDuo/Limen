import { createHash } from 'node:crypto';
import type { AppDatabase } from '@/lib/db';
import {
  unlockCredentialSlot,
  type CredentialKind,
} from '@/lib/crypto/key-slots';

/**
 * Session cookies and API tokens: `<slot id>.<secret>`, API tokens with a
 * recognisable prefix so they stand out in a Shortcut or a leaked paste.
 * Checking one means opening its key slot, which also yields the data key the
 * request needs; there is no other record of a valid session.
 */

export const API_TOKEN_PREFIX = 'limen_';

const PART = /^[A-Za-z0-9_-]{1,64}$/;

export type VerifiedCredential = {
  kind: CredentialKind;
  slotId: string;
  dataKey: Buffer;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
};

export function formatCredential(
  kind: CredentialKind,
  id: string,
  secret: string,
) {
  return `${kind === 'api_token' ? API_TOKEN_PREFIX : ''}${id}.${secret}`;
}

export function parseCredential(kind: CredentialKind, value: string) {
  let body = value.trim();
  if (kind === 'api_token') {
    if (!body.startsWith(API_TOKEN_PREFIX)) return null;
    body = body.slice(API_TOKEN_PREFIX.length);
  }
  const parts = body.split('.');
  if (parts.length !== 2 || !parts.every((part) => PART.test(part))) {
    return null;
  }
  return { id: parts[0], secret: parts[1] };
}

/**
 * One layout, a page and a few loaders all check the same cookie within a
 * single request, and neon-http makes each check a round trip. A minute of
 * reuse per instance bounds that; revoking on another instance therefore
 * takes up to a minute to bite there.
 */
const CACHE_TTL_MS = 60 * 1_000;
const CACHE_LIMIT = 200;

type CacheEntry = { credential: VerifiedCredential; cachedAt: number };
const caches = new WeakMap<object, Map<string, CacheEntry>>();

function cacheFor(database: AppDatabase) {
  let cache = caches.get(database);
  if (!cache) {
    cache = new Map();
    caches.set(database, cache);
  }
  return cache;
}

// Hashed so the cache never holds the secrets themselves as keys.
function cacheKey(kind: CredentialKind, value: string) {
  return createHash('sha256').update(`${kind}:${value}`).digest('base64url');
}

export async function verifyCredential(
  database: AppDatabase,
  kind: CredentialKind,
  value: string | null | undefined,
  now = new Date(),
): Promise<VerifiedCredential | null> {
  if (!value) return null;
  const parsed = parseCredential(kind, value);
  if (!parsed) return null;

  const cache = cacheFor(database);
  const key = cacheKey(kind, value);
  const hit = cache.get(key);
  if (
    hit &&
    now.getTime() - hit.cachedAt < CACHE_TTL_MS &&
    (!hit.credential.expiresAt || hit.credential.expiresAt > now)
  ) {
    return hit.credential;
  }

  const opened = await unlockCredentialSlot(
    database,
    kind,
    parsed.id,
    parsed.secret,
    now,
  );
  if (!opened) {
    cache.delete(key);
    return null;
  }
  const credential: VerifiedCredential = {
    kind,
    slotId: opened.slot.id,
    dataKey: opened.dataKey,
    expiresAt: opened.slot.expiresAt,
    lastUsedAt: opened.slot.lastUsedAt,
  };
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, { credential, cachedAt: now.getTime() });
  return credential;
}

/**
 * Drops this instance's cached verdicts for these slots, or for all of them.
 * Called after anything that revokes or changes a slot.
 */
export function forgetCredentials(database: AppDatabase, slotIds?: string[]) {
  const cache = caches.get(database);
  if (!cache) return;
  if (!slotIds) {
    cache.clear();
    return;
  }
  for (const [key, entry] of cache) {
    if (slotIds.includes(entry.credential.slotId)) cache.delete(key);
  }
}

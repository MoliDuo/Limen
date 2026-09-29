import { hkdfSync, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { and, eq, like, lte, ne, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AppDatabase } from '@/lib/db';
import { encryptionKeySlots, entries, tags } from '@/lib/db/schema';
import { anyEntryScope } from '@/lib/db/entry-scope';
import {
  CIPHERTEXT_PREFIX,
  openBytes,
  sealBytes,
} from '@/lib/crypto/field-cipher';

/**
 * Key slots: the data key, wrapped once per thing allowed to open it.
 *
 * A password slot derives its wrapping key with scrypt and nothing else — no
 * pepper, no key file — so the database plus the password is always enough to
 * read the diary back. Opening it is also how a login is checked; there is no
 * separate password hash. The flip side is that the salt and the wrapped key
 * sit in the database, so a stolen copy can be attacked offline and the
 * password's strength is the encryption's strength.
 *
 * Session and API token slots wrap the same key under a random 32-byte secret
 * that only the browser cookie or the API client holds. The server keeps no
 * secret of its own: a request that carries no valid credential cannot read
 * anything.
 */

export type ScryptParams = { N: number; r: number; p: number };
export type CredentialKind = 'session' | 'api_token';

/** 128 MiB and roughly a fifth of a second per attempt. */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

const INITIAL_SLOT_ID = 'initial';
const WRAP_AAD = 'limen/data-key/v1';
const CREDENTIAL_INFO = 'limen/credential-slot/v1';
const DATA_KEY_LENGTH = 32;

let paramsForNewSlots = DEFAULT_SCRYPT_PARAMS;

/** Tests would otherwise spend a fifth of a second per fresh database. */
export function setScryptParamsForNewSlots(params: ScryptParams) {
  paramsForNewSlots = params;
}

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

type SlotRow = typeof encryptionKeySlots.$inferSelect;
type SlotInsert = typeof encryptionKeySlots.$inferInsert;

const isPasswordSlot = eq(encryptionKeySlots.kind, 'password');

function derivePasswordKey(
  password: string,
  salt: Buffer,
  { N, r, p }: ScryptParams,
) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      password.normalize('NFC'),
      salt,
      DATA_KEY_LENGTH,
      // Node refuses anything above 32 MiB unless told otherwise.
      { N, r, p, maxmem: 256 * N * r },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** The secret is already 256 random bits; a slow hash would add nothing. */
function deriveCredentialKey(secret: Buffer, salt: Buffer) {
  return Buffer.from(
    hkdfSync('sha256', secret, salt, CREDENTIAL_INFO, DATA_KEY_LENGTH),
  );
}

function tryOpen(wrappingKey: Buffer, slot: SlotRow) {
  try {
    return openBytes(
      wrappingKey,
      Buffer.from(slot.wrappedKey, 'base64url'),
      WRAP_AAD,
    );
  } catch {
    return null;
  }
}

async function wrapForPassword(
  id: string,
  dataKey: Buffer,
  password: string,
): Promise<SlotInsert> {
  const salt = randomBytes(16);
  const params = paramsForNewSlots;
  const wrappingKey = await derivePasswordKey(password, salt, params);
  return {
    id,
    kind: 'password',
    kdf: 'scrypt',
    kdfParams: JSON.stringify(params),
    salt: salt.toString('base64url'),
    wrappedKey: sealBytes(wrappingKey, dataKey, WRAP_AAD).toString('base64url'),
  };
}

async function openPasswordSlot(slot: SlotRow, password: string) {
  if (slot.kdf !== 'scrypt') return null;
  const wrappingKey = await derivePasswordKey(
    password,
    Buffer.from(slot.salt, 'base64url'),
    JSON.parse(slot.kdfParams) as ScryptParams,
  );
  return tryOpen(wrappingKey, slot);
}

/** Opens the data key with the password, or returns null. The login check. */
export async function unlockWithPassword(
  database: AppDatabase,
  password: string,
) {
  const slots = await database
    .select()
    .from(encryptionKeySlots)
    .where(isPasswordSlot);
  for (const slot of slots) {
    const dataKey = await openPasswordSlot(slot, password);
    if (dataKey) return { slotId: slot.id, dataKey };
  }
  return null;
}

export async function countPasswordSlots(database: AppDatabase) {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(encryptionKeySlots)
    .where(isPasswordSlot);
  return row?.count ?? 0;
}

/**
 * A fresh data key is only safe to mint when nothing was ever encrypted.
 * Without this check, losing the slots table would silently start a second
 * key and leave every earlier entry unreadable under the first.
 */
async function hasEncryptedData(database: AppDatabase) {
  const pattern = `${CIPHERTEXT_PREFIX}%`;
  const [entryRow] = await database
    .select({ id: entries.id })
    .from(entries)
    // Both states on purpose: an encrypted entry in the bin counts too.
    .where(
      anyEntryScope(
        or(
          like(entries.content, pattern),
          like(entries.title, pattern),
          like(entries.summary, pattern),
        ),
      ),
    )
    .limit(1);
  if (entryRow) return true;
  // Tag names are always stored encrypted.
  const [tagRow] = await database.select({ id: tags.id }).from(tags).limit(1);
  return Boolean(tagRow);
}

/**
 * Opens the data key with the password, minting it first on a database that
 * has never had one. Only `npm run crypto -- init` and tests call this;
 * everything else opens an existing key or fails.
 *
 * Never mints a key when any slot exists or anything is already encrypted.
 */
export async function unlockDataKey(
  database: AppDatabase,
  password: string,
): Promise<Buffer> {
  const [anySlot] = await database
    .select({ id: encryptionKeySlots.id })
    .from(encryptionKeySlots)
    .limit(1);

  if (!anySlot) {
    if (await hasEncryptedData(database)) {
      throw new EncryptionKeyError(
        'Encrypted entries exist but encryption_key_slots is empty. Refusing to create a new key; restore the slots table from a backup.',
      );
    }
    // Two first requests can race here. The fixed id lets exactly one insert
    // win; both then read back and use the winner's key.
    await database
      .insert(encryptionKeySlots)
      .values(
        await wrapForPassword(
          INITIAL_SLOT_ID,
          randomBytes(DATA_KEY_LENGTH),
          password,
        ),
      )
      .onConflictDoNothing();
  }

  const opened = await unlockWithPassword(database, password);
  if (!opened) {
    throw new EncryptionKeyError(
      'This password does not open the encryption key.',
    );
  }
  return opened.dataKey;
}

/**
 * Wraps the data key for a new session or API token. The returned secret is
 * never stored; it goes to the cookie or the client and nowhere else.
 */
export async function createCredentialSlot(
  database: AppDatabase,
  dataKey: Buffer,
  kind: CredentialKind,
  {
    label = null,
    expiresAt = null,
  }: { label?: string | null; expiresAt?: Date | null } = {},
) {
  const id = nanoid();
  const secret = randomBytes(DATA_KEY_LENGTH);
  const salt = randomBytes(16);
  await database.insert(encryptionKeySlots).values({
    id,
    kind,
    kdf: 'hkdf',
    kdfParams: '{}',
    salt: salt.toString('base64url'),
    wrappedKey: sealBytes(
      deriveCredentialKey(secret, salt),
      dataKey,
      WRAP_AAD,
    ).toString('base64url'),
    label,
    expiresAt,
  });
  return { id, secret: secret.toString('base64url') };
}

/** Null for an unknown, revoked, expired or tampered credential. */
export async function unlockCredentialSlot(
  database: AppDatabase,
  kind: CredentialKind,
  id: string,
  secret: string,
  now = new Date(),
) {
  const [slot] = await database
    .select()
    .from(encryptionKeySlots)
    .where(
      and(eq(encryptionKeySlots.id, id), eq(encryptionKeySlots.kind, kind)),
    )
    .limit(1);
  if (!slot || slot.kdf !== 'hkdf') return null;
  if (slot.expiresAt && slot.expiresAt <= now) return null;
  const secretBytes = Buffer.from(secret, 'base64url');
  if (secretBytes.length !== DATA_KEY_LENGTH) return null;
  const dataKey = tryOpen(
    deriveCredentialKey(secretBytes, Buffer.from(slot.salt, 'base64url')),
    slot,
  );
  return dataKey ? { slot, dataKey } : null;
}

/**
 * Replaces the password. Adds the new slot before removing the old ones, so
 * an interruption leaves both passwords working rather than neither; running
 * it again finishes the job. Every session except `keepSessionId` is signed
 * out, since whoever knew the old password may be holding one.
 */
export async function changePassword(
  database: AppDatabase,
  currentPassword: string,
  newPassword: string,
  { keepSessionId }: { keepSessionId?: string } = {},
) {
  const opened = await unlockWithPassword(database, currentPassword);
  if (!opened) return false;
  const next = await wrapForPassword(nanoid(), opened.dataKey, newPassword);
  await database.insert(encryptionKeySlots).values(next);
  await database
    .delete(encryptionKeySlots)
    .where(and(isPasswordSlot, ne(encryptionKeySlots.id, next.id)));
  await revokeSessions(database, { except: keepSessionId });
  return true;
}

export async function revokeSessions(
  database: AppDatabase,
  { except }: { except?: string } = {},
) {
  const removed = await database
    .delete(encryptionKeySlots)
    .where(
      and(
        eq(encryptionKeySlots.kind, 'session'),
        except ? ne(encryptionKeySlots.id, except) : undefined,
      ),
    )
    .returning({ id: encryptionKeySlots.id });
  return removed.map((row) => row.id);
}

export async function deleteCredentialSlot(
  database: AppDatabase,
  kind: CredentialKind,
  id: string,
) {
  const removed = await database
    .delete(encryptionKeySlots)
    .where(
      and(eq(encryptionKeySlots.id, id), eq(encryptionKeySlots.kind, kind)),
    )
    .returning({ id: encryptionKeySlots.id });
  return removed.length > 0;
}

export async function deleteExpiredSessions(
  database: AppDatabase,
  now = new Date(),
) {
  await database
    .delete(encryptionKeySlots)
    .where(
      and(
        eq(encryptionKeySlots.kind, 'session'),
        lte(encryptionKeySlots.expiresAt, now),
      ),
    );
}

export async function updateCredentialSlot(
  database: AppDatabase,
  id: string,
  values: { expiresAt?: Date; lastUsedAt?: Date },
) {
  await database
    .update(encryptionKeySlots)
    .set(values)
    .where(eq(encryptionKeySlots.id, id));
}

export async function listApiTokens(database: AppDatabase) {
  return database
    .select({
      id: encryptionKeySlots.id,
      label: encryptionKeySlots.label,
      createdAt: encryptionKeySlots.createdAt,
      lastUsedAt: encryptionKeySlots.lastUsedAt,
    })
    .from(encryptionKeySlots)
    .where(eq(encryptionKeySlots.kind, 'api_token'))
    .orderBy(encryptionKeySlots.createdAt);
}

export async function countKeySlots(database: AppDatabase) {
  const rows = await database
    .select({
      kind: encryptionKeySlots.kind,
      count: sql<number>`count(*)::int`,
    })
    .from(encryptionKeySlots)
    .groupBy(encryptionKeySlots.kind);
  const counts = { password: 0, session: 0, api_token: 0 };
  for (const row of rows) {
    if (row.kind in counts) counts[row.kind as keyof typeof counts] = row.count;
  }
  return counts;
}

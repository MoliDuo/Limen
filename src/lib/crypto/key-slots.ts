import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { isNotNull, like, or, sql } from 'drizzle-orm';
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
 * Key slots: the data key, wrapped under a key derived from a password.
 *
 * Deliberately nothing but the password goes into the derivation — no pepper,
 * no key file — so the database plus the password is always enough to read
 * the diary back. The flip side is that the salt and the wrapped key sit in
 * the database, so a stolen copy can be attacked offline and the password's
 * strength is the encryption's strength.
 */

export type ScryptParams = { N: number; r: number; p: number };

/** 128 MiB and roughly a third of a second per attempt. */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

const INITIAL_SLOT_ID = 'initial';
const WRAP_AAD = 'limen/data-key/v1';
const DATA_KEY_LENGTH = 32;

let paramsForNewSlots = DEFAULT_SCRYPT_PARAMS;

/** Tests would otherwise spend a third of a second per fresh database. */
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

function deriveWrappingKey(
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

async function wrapDataKey(
  id: string,
  dataKey: Buffer,
  password: string,
): Promise<typeof encryptionKeySlots.$inferInsert> {
  const salt = randomBytes(16);
  const params = paramsForNewSlots;
  const wrappingKey = await deriveWrappingKey(password, salt, params);
  return {
    id,
    kdf: 'scrypt',
    kdfParams: JSON.stringify(params),
    salt: salt.toString('base64url'),
    wrappedKey: sealBytes(wrappingKey, dataKey, WRAP_AAD).toString('base64url'),
  };
}

async function unwrapSlot(slot: SlotRow, password: string) {
  if (slot.kdf !== 'scrypt') return null;
  const params = JSON.parse(slot.kdfParams) as ScryptParams;
  const wrappingKey = await deriveWrappingKey(
    password,
    Buffer.from(slot.salt, 'base64url'),
    params,
  );
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

async function findOpenableSlot(slots: SlotRow[], password: string) {
  for (const slot of slots) {
    const dataKey = await unwrapSlot(slot, password);
    if (dataKey) return { slot, dataKey };
  }
  return null;
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
  const [tagRow] = await database
    .select({ id: tags.id })
    .from(tags)
    .where(isNotNull(tags.nameHmac))
    .limit(1);
  return Boolean(tagRow);
}

/**
 * Opens the data key with the password, creating it on first use.
 *
 * Never creates a key when slots exist but none opens: a Preview deployment
 * with a different AUTH_PASSWORD must fail loudly, not start a second key.
 */
export async function unlockDataKey(
  database: AppDatabase,
  password: string,
): Promise<Buffer> {
  let slots = await database.select().from(encryptionKeySlots);

  if (slots.length === 0) {
    if (await hasEncryptedData(database)) {
      throw new EncryptionKeyError(
        'Encrypted entries exist but encryption_key_slots is empty. Refusing to create a new key; restore the slots table from a backup.',
      );
    }
    const slot = await wrapDataKey(
      INITIAL_SLOT_ID,
      randomBytes(DATA_KEY_LENGTH),
      password,
    );
    // Two cold starts can race here. The fixed id lets exactly one insert
    // win; both then read back and use the winner's key.
    await database
      .insert(encryptionKeySlots)
      .values(slot)
      .onConflictDoNothing();
    slots = await database.select().from(encryptionKeySlots);
  }

  const opened = await findOpenableSlot(slots, password);
  if (!opened) {
    throw new EncryptionKeyError(
      'AUTH_PASSWORD does not open any encryption key slot. It must be the password the diary was encrypted with; see docs/encryption.md to change it.',
    );
  }
  return opened.dataKey;
}

/** Lets a second password open the same data key. */
export async function addPasswordSlot(
  database: AppDatabase,
  currentPassword: string,
  newPassword: string,
) {
  const dataKey = await unlockDataKey(database, currentPassword);
  const slots = await database.select().from(encryptionKeySlots);
  if (await findOpenableSlot(slots, newPassword)) return { added: false };
  await database
    .insert(encryptionKeySlots)
    .values(await wrapDataKey(nanoid(), dataKey, newPassword));
  return { added: true };
}

/** Removes every slot except the one this password opens. */
export async function removeOtherPasswordSlots(
  database: AppDatabase,
  password: string,
) {
  const slots = await database.select().from(encryptionKeySlots);
  const opened = await findOpenableSlot(slots, password);
  if (!opened) {
    throw new EncryptionKeyError(
      'This password does not open any key slot; nothing was removed.',
    );
  }
  const removed = await database
    .delete(encryptionKeySlots)
    .where(sql`${encryptionKeySlots.id} <> ${opened.slot.id}`)
    .returning({ id: encryptionKeySlots.id });
  return { kept: opened.slot.id, removed: removed.length };
}

export async function countKeySlots(database: AppDatabase) {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(encryptionKeySlots);
  return row?.count ?? 0;
}

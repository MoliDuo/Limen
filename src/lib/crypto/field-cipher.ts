import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/**
 * Field-level encryption for everything the diary knows about its owner.
 *
 * One random 32-byte data key encrypts every field; lib/crypto/key-slots.ts
 * keeps it wrapped under the master password. Two subkeys are derived from it
 * with HKDF so the same key material is never used for two purposes.
 *
 * The format is spelled out in docs/encryption.md so the data stays readable
 * with nothing but the database and the password.
 */

export const CIPHERTEXT_PREFIX = 'enc:v1:';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export type EntryField = 'content' | 'title' | 'summary';

/** AES-256-GCM. Output is iv ‖ ciphertext ‖ tag. */
export function sealBytes(key: Buffer, plaintext: Buffer, aad: string) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

/** Throws when the key, the AAD or any byte of the input is wrong. */
export function openBytes(key: Buffer, sealed: Buffer, aad: string) {
  if (sealed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext is truncated');
  }
  const iv = sealed.subarray(0, IV_LENGTH);
  const tag = sealed.subarray(sealed.length - AUTH_TAG_LENGTH);
  const body = sealed.subarray(IV_LENGTH, sealed.length - AUTH_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function isEncrypted(value: string) {
  return value.startsWith(CIPHERTEXT_PREFIX);
}

/**
 * Binds a ciphertext to its row and column, so a database writer cannot move
 * one entry's text into another entry or turn a summary into a title.
 */
export function entryFieldAad(id: string, field: EntryField) {
  return `entries.${field}:${id}`;
}

const TAG_NAME_AAD = 'tags.name';

export class FieldCipher {
  readonly #encryptionKey: Buffer;
  readonly #indexKey: Buffer;

  constructor(dataKey: Buffer) {
    if (dataKey.length !== KEY_LENGTH) throw new Error('Invalid data key');
    this.#encryptionKey = Buffer.from(
      hkdfSync('sha256', dataKey, Buffer.alloc(0), 'limen/fields/v1', 32),
    );
    this.#indexKey = Buffer.from(
      hkdfSync('sha256', dataKey, Buffer.alloc(0), 'limen/tag-index/v1', 32),
    );
  }

  encrypt(value: string, aad: string) {
    const sealed = sealBytes(
      this.#encryptionKey,
      Buffer.from(value, 'utf8'),
      aad,
    );
    return CIPHERTEXT_PREFIX + sealed.toString('base64url');
  }

  /**
   * Values without the prefix are rows written before encryption existed and
   * are returned as they are, so reads keep working while the backfill runs.
   * A prefixed value that fails to open is an error, never a passthrough.
   */
  decrypt(value: string, aad: string) {
    if (!isEncrypted(value)) return value;
    const sealed = Buffer.from(
      value.slice(CIPHERTEXT_PREFIX.length),
      'base64url',
    );
    return openBytes(this.#encryptionKey, sealed, aad).toString('utf8');
  }

  encryptEntryField(id: string, field: EntryField, value: string): string;
  encryptEntryField(
    id: string,
    field: EntryField,
    value: string | null,
  ): string | null;
  encryptEntryField(id: string, field: EntryField, value: string | null) {
    return value === null
      ? null
      : this.encrypt(value, entryFieldAad(id, field));
  }

  decryptEntryField(id: string, field: EntryField, value: string): string;
  decryptEntryField(
    id: string,
    field: EntryField,
    value: string | null,
  ): string | null;
  decryptEntryField(id: string, field: EntryField, value: string | null) {
    return value === null
      ? null
      : this.decrypt(value, entryFieldAad(id, field));
  }

  encryptTagName(name: string) {
    return this.encrypt(name, TAG_NAME_AAD);
  }

  decryptTagName(value: string) {
    return this.decrypt(value, TAG_NAME_AAD);
  }

  /**
   * Deterministic keyed hash of a tag name: the unique key and the filter
   * value. It reveals which entries share a tag, which entry_tags already
   * does, but not what the tag says.
   */
  tagIndex(name: string) {
    return createHmac('sha256', this.#indexKey)
      .update(name, 'utf8')
      .digest('base64url');
  }
}

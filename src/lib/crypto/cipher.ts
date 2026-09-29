import type { AppDatabase } from '@/lib/db';
import { FieldCipher } from '@/lib/crypto/field-cipher';
import { unlockDataKey } from '@/lib/crypto/key-slots';

type CachedCipher = { password: string; cipher: Promise<FieldCipher> };

// Keyed by database handle: production has one for the life of the instance,
// so the scrypt cost is paid once per cold start; each test database gets its
// own key.
const cache = new WeakMap<object, CachedCipher>();

/**
 * The cipher for this database, unlocked with AUTH_PASSWORD.
 *
 * Every read or write of entry text, titles, summaries or tag names awaits
 * this once and then encrypts and decrypts synchronously.
 */
export function getFieldCipher(database: AppDatabase): Promise<FieldCipher> {
  const password = process.env.AUTH_PASSWORD;
  if (!password) {
    return Promise.reject(new Error('AUTH_PASSWORD is required'));
  }
  const cached = cache.get(database);
  if (cached && cached.password === password) return cached.cipher;

  const cipher = unlockDataKey(database, password).then(
    (dataKey) => new FieldCipher(dataKey),
  );
  cache.set(database, { password, cipher });
  // A failed unlock (the database was briefly unreachable, say) must not be
  // remembered for the rest of the instance's life.
  cipher.catch(() => {
    if (cache.get(database)?.cipher === cipher) cache.delete(database);
  });
  return cipher;
}

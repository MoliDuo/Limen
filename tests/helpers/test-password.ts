import type { AppDatabase } from '@/lib/db';
import { unlockDataKey } from '@/lib/crypto/key-slots';

/** The master password every test database is initialised with. */
export const TEST_PASSWORD = 'test-master-password';

const keys = new WeakMap<object, Promise<Buffer>>();

/**
 * Stands in for the request's session in tests: opens (or, on a fresh
 * database, mints) the data key with TEST_PASSWORD, once per database.
 */
export function testDataKey(database: AppDatabase) {
  let key = keys.get(database);
  if (!key) {
    key = unlockDataKey(database, TEST_PASSWORD);
    // A failed unlock must not stick; the next call tries again.
    key.catch(() => keys.delete(database));
    keys.set(database, key);
  }
  return key;
}

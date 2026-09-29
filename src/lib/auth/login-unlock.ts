import { db, type AppDatabase } from '@/lib/db';
import { countPasswordSlots, unlockWithPassword } from '@/lib/crypto/key-slots';
import type { UnlockResult } from './action-core';

/**
 * The password check is opening a password slot. A database without one has
 * never been set up; `npm run crypto -- init` does that.
 */
export async function unlockForLogin(
  password: string,
  database: AppDatabase = db,
): Promise<UnlockResult> {
  const opened = await unlockWithPassword(database, password);
  if (opened) return opened.dataKey;
  return (await countPasswordSlots(database)) > 0 ? null : 'uninitialized';
}

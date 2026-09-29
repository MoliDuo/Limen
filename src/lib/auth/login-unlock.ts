import { db, type AppDatabase } from '@/lib/db';
import {
  countPasswordSlots,
  unlockDataKey,
  unlockWithPassword,
} from '@/lib/crypto/key-slots';
import type { UnlockResult } from './action-core';
import { secureStringEqual } from './security';

/**
 * The password check is opening a password slot. A database without one is
 * either brand new (set it up with `npm run crypto -- init`) or an upgrade
 * from when the password lived in AUTH_PASSWORD; in the second case the old
 * variable, if still set, is accepted exactly once to create the slot.
 */
export async function unlockForLogin(
  password: string,
  database: AppDatabase = db,
  legacyPassword = process.env.AUTH_PASSWORD,
): Promise<UnlockResult> {
  const opened = await unlockWithPassword(database, password);
  if (opened) return opened.dataKey;
  if ((await countPasswordSlots(database)) > 0) return null;
  if (!legacyPassword) return 'uninitialized';
  if (!secureStringEqual(password, legacyPassword)) return null;
  return unlockDataKey(database, password);
}

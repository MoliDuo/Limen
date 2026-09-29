import { eq } from 'drizzle-orm';
import { db, type AppDatabase } from '@/lib/db';
import { entries } from '@/lib/db/schema';
import { entryTagNamesSql, parseTagNames } from '@/lib/db/entry-tags';
import { activeEntries, trashedEntries } from '@/lib/db/entry-scope';
import { getFieldCipher } from '@/lib/crypto/cipher';

export type EntryRecord = {
  id: string;
  content: string;
  title: string | null;
  summary: string | null;
  tags: string[];
  source: string | null;
  aiStatus: string | null;
  titleLockedAt: Date | null;
  tagsLockedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  recordedAt: Date;
  updatedAt: Date;
};

const ENTRY_COLUMNS = {
  id: entries.id,
  content: entries.content,
  title: entries.title,
  summary: entries.summary,
  tags: entryTagNamesSql,
  source: entries.source,
  aiStatus: entries.aiStatus,
  titleLockedAt: entries.titleLockedAt,
  tagsLockedAt: entries.tagsLockedAt,
  deletedAt: entries.deletedAt,
  createdAt: entries.createdAt,
  recordedAt: entries.recordedAt,
  updatedAt: entries.updatedAt,
};

async function findOne(
  database: AppDatabase,
  where: ReturnType<typeof activeEntries>,
): Promise<EntryRecord | undefined> {
  const cipher = await getFieldCipher(database);
  const rows = await database
    .select(ENTRY_COLUMNS)
    .from(entries)
    .where(where)
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    ...row,
    content: cipher.decryptEntryField(row.id, 'content', row.content),
    title: cipher.decryptEntryField(row.id, 'title', row.title),
    summary: cipher.decryptEntryField(row.id, 'summary', row.summary),
    tags: parseTagNames(cipher, row.tags),
  };
}

/**
 * Single-entry reads go through here so the deleted-state filter cannot be
 * forgotten at the call site.
 */
export function findActiveEntry(id: string, database: AppDatabase = db) {
  return findOne(database, activeEntries(eq(entries.id, id)));
}

export function findTrashedEntry(id: string, database: AppDatabase = db) {
  return findOne(database, trashedEntries(eq(entries.id, id)));
}

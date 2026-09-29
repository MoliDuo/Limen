import type { AppDatabase } from '@/lib/db';
import { entries } from '@/lib/db/schema';
import { syncEntryTags } from '@/lib/db/entry-tags';
import { getFieldCipher } from '@/lib/crypto/cipher';

type SeedEntryOptions = Partial<Omit<typeof entries.$inferInsert, 'tags'>> & {
  /** Written to entry_tags, bypassing tags_locked_at. */
  tags?: string[];
};

export async function seedEntry(db: AppDatabase, value: SeedEntryOptions = {}) {
  const now = new Date();
  const { tags, ...columns } = value;
  const entry = {
    id: columns.id ?? 'entry-1',
    content: columns.content ?? 'Seeded entry content',
    title: columns.title ?? null,
    summary: columns.summary ?? null,
    source: columns.source ?? 'web',
    aiStatus: columns.aiStatus ?? 'pending',
    tagsLockedAt: columns.tagsLockedAt ?? null,
    createdAt: columns.createdAt ?? now,
    recordedAt: columns.recordedAt ?? now,
    updatedAt: columns.updatedAt ?? now,
  } satisfies typeof entries.$inferInsert;

  // Stored the way the app stores it.
  const cipher = await getFieldCipher(db);
  await db.insert(entries).values({
    ...entry,
    content: cipher.encryptEntryField(entry.id, 'content', entry.content),
    title: cipher.encryptEntryField(entry.id, 'title', entry.title),
    summary: cipher.encryptEntryField(entry.id, 'summary', entry.summary),
  });
  if (tags && tags.length > 0) {
    await syncEntryTags(db, entry.id, tags, { respectLock: false });
  }
  return { ...entry, tags: tags ?? [] };
}

/**
 * A row as stored, with the encrypted columns decrypted. Deliberately bypasses
 * the app's scoped readers so tests can inspect trashed rows too.
 */
export async function readStoredEntry(db: AppDatabase, id: string) {
  const row = await db.query.entries.findFirst({
    where: (fields, { eq }) => eq(fields.id, id),
  });
  if (!row) return undefined;
  const cipher = await getFieldCipher(db);
  return {
    ...row,
    content: cipher.decryptEntryField(id, 'content', row.content),
    title: cipher.decryptEntryField(id, 'title', row.title),
    summary: cipher.decryptEntryField(id, 'summary', row.summary),
  };
}

import { asc, gte, lte, type SQL } from 'drizzle-orm';
import type { AppDatabase } from '@/lib/db';
import { entries } from '@/lib/db/schema';
import {
  entryTagNamesSql,
  hasAnyTag,
  parseTagNames,
} from '@/lib/db/entry-tags';
import { activeEntries } from '@/lib/db/entry-scope';
import { getFieldCipher } from '@/lib/crypto/cipher';
import type { ExportFilters } from '@/lib/export-core';

export async function loadExportEntries(
  database: AppDatabase,
  filters: ExportFilters,
) {
  const cipher = await getFieldCipher(database);
  const conditions: SQL[] = [];
  if (filters.from)
    conditions.push(
      gte(entries.createdAt, new Date(`${filters.from}T00:00:00Z`)),
    );
  if (filters.to)
    conditions.push(
      lte(entries.createdAt, new Date(`${filters.to}T00:00:00Z`)),
    );
  // OR semantics across the selected tags, matched in SQL rather than by
  // loading every row and filtering in JS.
  if (filters.tags.length > 0) conditions.push(hasAnyTag(cipher, filters.tags));
  const rows = await database
    .select({
      id: entries.id,
      content: entries.content,
      title: entries.title,
      summary: entries.summary,
      tags: entryTagNamesSql,
      source: entries.source,
      aiStatus: entries.aiStatus,
      createdAt: entries.createdAt,
      recordedAt: entries.recordedAt,
      updatedAt: entries.updatedAt,
    })
    .from(entries)
    .where(activeEntries(...conditions))
    .orderBy(asc(entries.createdAt), asc(entries.recordedAt), asc(entries.id));
  return rows.map((row) => ({
    ...row,
    content: cipher.decryptEntryField(row.id, 'content', row.content),
    title: cipher.decryptEntryField(row.id, 'title', row.title),
    summary: cipher.decryptEntryField(row.id, 'summary', row.summary),
    tags: parseTagNames(cipher, row.tags),
  }));
}

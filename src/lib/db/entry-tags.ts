import { inArray, sql, type SQL } from 'drizzle-orm';
import type { AppDatabase } from '@/lib/db';
import { entries, entryTags, tags } from '@/lib/db/schema';
import { normalizeTags } from '@/lib/tags';
import { activeEntries } from '@/lib/db/entry-scope';
import { getFieldCipher } from '@/lib/crypto/cipher';
import type { FieldCipher } from '@/lib/crypto/field-cipher';

/**
 * A correlated subquery returning an entry's encrypted tag names as a JSON
 * array string; parseTagNames decrypts and orders them.
 *
 * Cast to ::text and parsed in JS rather than relying on the driver's JSON
 * handling, because neon-http and PGlite decode json columns differently.
 */
/*
 * Identifiers are written out and table-qualified rather than interpolated as
 * Drizzle columns: inside a correlated subquery Drizzle renders them bare, so
 * `${entries.id}` becomes "id" and silently binds to tags.id instead.
 */
export const entryTagNamesSql = sql<string>`(
  SELECT coalesce(json_agg(t.name), '[]')::text
  FROM entry_tags et
  JOIN tags t ON t.id = et.tag_id
  WHERE et.entry_id = "entries"."id"
)`;

/**
 * Sorted in JS because the database only holds ciphertext, and because
 * Postgres collation would not reproduce pinyin order anyway.
 */
function sortTagNames(names: Iterable<string>) {
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export function parseTagNames(
  cipher: FieldCipher,
  value: string | null,
): string[] {
  if (!value) return [];
  let stored: unknown;
  try {
    stored = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];
  return sortTagNames(
    normalizeTags(
      stored.map((name) =>
        typeof name === 'string' ? cipher.decryptTagName(name) : name,
      ),
    ),
  );
}

export async function loadEntryTagsMap(
  database: AppDatabase,
  ids: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return map;
  const cipher = await getFieldCipher(database);
  const rows = await database
    .select({ entryId: entryTags.entryId, name: tags.name })
    .from(entryTags)
    .innerJoin(tags, sql`${tags.id} = ${entryTags.tagId}`)
    .where(inArray(entryTags.entryId, ids));
  for (const row of rows)
    map.get(row.entryId)?.push(cipher.decryptTagName(row.name));
  for (const [id, names] of map) map.set(id, sortTagNames(new Set(names)));
  return map;
}

/**
 * Every tag attached to at least one entry the owner can still see.
 *
 * Replaces the full-table scans that both the AI prompt and the settings
 * export list used to do over entries.tags.
 */
export async function listActiveTagNames(
  database: AppDatabase,
): Promise<string[]> {
  const cipher = await getFieldCipher(database);
  const rows = await database
    .selectDistinct({ name: tags.name })
    .from(tags)
    .innerJoin(entryTags, sql`${entryTags.tagId} = ${tags.id}`)
    .innerJoin(entries, sql`${entries.id} = ${entryTags.entryId}`)
    // Without this a trashed entry's tags keep feeding the AI prompt and keep
    // showing up as export checkboxes that can never match anything.
    .where(activeEntries());
  // The Set folds a not-yet-backfilled plaintext row into its encrypted twin.
  return sortTagNames(
    new Set(rows.map((row) => cipher.decryptTagName(row.name))),
  );
}

/**
 * "This entry carries at least one of these tags." Uses the tag_id index.
 *
 * Matches on the keyed hash; the plaintext branch only covers tag rows the
 * encryption backfill has not reached yet, and the names it compares are
 * query parameters, never stored.
 */
export function hasAnyTag(cipher: FieldCipher, names: string[]): SQL {
  if (names.length === 0) return sql`false`;
  const hashes = names.map((name) => cipher.tagIndex(name));
  return sql`EXISTS (
    SELECT 1 FROM entry_tags et
    JOIN tags t ON t.id = et.tag_id
    WHERE et.entry_id = "entries"."id"
      AND (
        t.name_hmac = ANY(${sql.param(hashes)})
        OR (t.name_hmac IS NULL AND t.name = ANY(${sql.param(names)}))
      )
  )`;
}

/**
 * The only writer of entry_tags.
 *
 * neon-http has no interactive transactions, so this cannot be wrapped in one:
 * .transaction() type-checks, works under PGlite, and throws at runtime on
 * Neon. Inserts therefore run before the delete, so an interruption leaves a
 * superset of the intended tags rather than a gap.
 *
 * `respectLock` is enforced inside the SQL predicates instead of a read-then-
 * write in JS, which makes it race-free without a transaction.
 */
export async function syncEntryTags(
  database: AppDatabase,
  entryId: string,
  names: string[],
  { respectLock = true }: { respectLock?: boolean } = {},
): Promise<void> {
  const normalized = normalizeTags(names);
  const cipher = await getFieldCipher(database);
  const hashes = normalized.map((name) => cipher.tagIndex(name));
  const unlocked = respectLock
    ? sql`EXISTS (
        SELECT 1 FROM entries e
        WHERE e.id = ${entryId} AND e.tags_locked_at IS NULL
      )`
    : sql`true`;

  if (normalized.length > 0) {
    await database
      .insert(tags)
      .values(
        normalized.map((name, index) => ({
          name: cipher.encryptTagName(name),
          nameHmac: hashes[index],
        })),
      )
      .onConflictDoNothing();
    await database.execute(sql`
      INSERT INTO entry_tags (entry_id, tag_id)
      SELECT ${entryId}, t.id FROM tags t
      WHERE t.name_hmac = ANY(${sql.param(hashes)}) AND ${unlocked}
      ON CONFLICT DO NOTHING
    `);
  }

  const keep =
    normalized.length > 0
      ? sql`AND entry_tags.tag_id NOT IN (
          SELECT t.id FROM tags t WHERE t.name_hmac = ANY(${sql.param(hashes)})
        )`
      : sql``;

  await database.execute(sql`
    DELETE FROM entry_tags
    WHERE entry_tags.entry_id = ${entryId}
      ${keep}
      AND ${unlocked}
  `);
}

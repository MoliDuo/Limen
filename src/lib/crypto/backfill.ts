import { and, eq, isNull, not, like, or, sql, type SQL } from 'drizzle-orm';
import type { AppDatabase } from '@/lib/db';
import { entries, tags } from '@/lib/db/schema';
import { anyEntryScope } from '@/lib/db/entry-scope';
import { getFieldCipher } from '@/lib/crypto/cipher';
import {
  CIPHERTEXT_PREFIX,
  isEncrypted,
  type EntryField,
  type FieldCipher,
} from '@/lib/crypto/field-cipher';

/**
 * Encrypts rows written before field encryption existed.
 *
 * neon-http has no transactions, so every step is a single statement that is
 * safe to interrupt and repeat: each UPDATE is conditioned on the plaintext it
 * read, so a concurrent edit is never overwritten, and a row that lost that
 * race is simply picked up again on the next pass.
 */

const BATCH_SIZE = 50;
const PLAINTEXT = not(like(entries.content, `${CIPHERTEXT_PREFIX}%`));

function isPlaintext(column: typeof entries.title | typeof entries.summary) {
  return and(
    sql`${column} is not null`,
    not(like(column, `${CIPHERTEXT_PREFIX}%`)),
  );
}

// Both states on purpose: an entry in the recycle bin is still the owner's
// words and must not stay readable.
const LEGACY_ENTRY = anyEntryScope(
  or(PLAINTEXT, isPlaintext(entries.title), isPlaintext(entries.summary)),
) as SQL;

export type BackfillResult = {
  entries: number;
  tags: number;
  /** False when the deadline stopped the run before everything was done. */
  complete: boolean;
};

export async function encryptLegacyRows(
  database: AppDatabase,
  {
    deadline = Number.POSITIVE_INFINITY,
    cipher: givenCipher,
  }: { deadline?: number; cipher?: FieldCipher } = {},
): Promise<BackfillResult> {
  const cipher = givenCipher ?? (await getFieldCipher(database));
  const result: BackfillResult = { entries: 0, tags: 0, complete: false };

  // Rows skipped because a concurrent write won; they are not retried in this
  // run, which keeps the loop finite.
  const skipped = new Set<string>();
  while (Date.now() < deadline) {
    const rows = await database
      .select({
        id: entries.id,
        content: entries.content,
        title: entries.title,
        summary: entries.summary,
      })
      .from(entries)
      .where(LEGACY_ENTRY)
      .orderBy(entries.id)
      .limit(BATCH_SIZE + skipped.size);
    const pending = rows.filter((row) => !skipped.has(row.id));
    if (pending.length === 0) break;

    for (const row of pending) {
      const changes: Partial<Record<EntryField, string>> = {};
      const unchanged: SQL[] = [];
      for (const field of ['content', 'title', 'summary'] as const) {
        const value = row[field];
        if (value === null || isEncrypted(value)) continue;
        changes[field] = cipher.encryptEntryField(row.id, field, value);
        unchanged.push(eq(entries[field], value));
      }
      const updated = await database
        .update(entries)
        .set(changes)
        .where(anyEntryScope(eq(entries.id, row.id), ...unchanged))
        .returning({ id: entries.id });
      if (updated.length > 0) result.entries += 1;
      else skipped.add(row.id);
    }
  }

  while (Date.now() < deadline) {
    const rows = await database
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(isNull(tags.nameHmac))
      .orderBy(tags.id)
      .limit(BATCH_SIZE);
    if (rows.length === 0) {
      result.complete = skipped.size === 0;
      break;
    }
    for (const row of rows) {
      await encryptLegacyTag(database, cipher.tagIndex(row.name), {
        id: row.id,
        encryptedName: cipher.encryptTagName(row.name),
      });
      result.tags += 1;
    }
  }

  return result;
}

/**
 * A plaintext tag row either becomes encrypted in place or, when the new code
 * already created the encrypted twin for the same name, is folded into it.
 */
async function encryptLegacyTag(
  database: AppDatabase,
  nameHmac: string,
  legacy: { id: number; encryptedName: string },
) {
  const [twin] = await database
    .select({ id: tags.id })
    .from(tags)
    .where(eq(tags.nameHmac, nameHmac))
    .limit(1);
  if (!twin) {
    await database
      .update(tags)
      .set({ name: legacy.encryptedName, nameHmac })
      .where(and(eq(tags.id, legacy.id), isNull(tags.nameHmac)));
    return;
  }
  // Insert before delete, as in syncEntryTags: an interruption between the two
  // leaves the entry with both rows, which reads as one tag, never with none.
  await database.execute(sql`
    INSERT INTO entry_tags (entry_id, tag_id, created_at)
    SELECT entry_id, ${twin.id}, created_at FROM entry_tags
    WHERE tag_id = ${legacy.id}
    ON CONFLICT DO NOTHING
  `);
  await database
    .delete(tags)
    .where(and(eq(tags.id, legacy.id), isNull(tags.nameHmac)));
}

/** How much is still stored in plaintext. */
export async function countLegacyRows(database: AppDatabase) {
  const [entryCount] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(entries)
    .where(LEGACY_ENTRY);
  const [tagCount] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(tags)
    .where(isNull(tags.nameHmac));
  return { entries: entryCount?.count ?? 0, tags: tagCount?.count ?? 0 };
}

/** At most one background pass per instance per minute, none once done. */
const BACKGROUND_THROTTLE_MS = 60 * 1_000;
/** Leaves headroom inside the 60-second function limit. */
const BACKGROUND_BUDGET_MS = 20 * 1_000;

let lastBackgroundRunAt = 0;
let backgroundDone = false;

/**
 * Runs from after() on the timeline, so an upgraded deployment encrypts its
 * old rows without anyone having to remember a command. Large diaries finish
 * over several visits; `npm run crypto encrypt-existing` does it in one go.
 * Takes the cipher from the render that scheduled it, since after() in a
 * Server Component cannot read the session cookie.
 */
export async function encryptLegacyRowsInBackground(
  database: AppDatabase,
  cipher: FieldCipher,
  now = Date.now(),
) {
  if (backgroundDone || now - lastBackgroundRunAt < BACKGROUND_THROTTLE_MS)
    return;
  lastBackgroundRunAt = now;
  try {
    const result = await encryptLegacyRows(database, {
      deadline: now + BACKGROUND_BUDGET_MS,
      cipher,
    });
    if (result.complete) backgroundDone = true;
  } catch (error) {
    console.error('Encrypting legacy rows failed:', error);
  }
}

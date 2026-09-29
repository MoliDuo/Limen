import { and, desc, eq, lt, or, sql, type SQL } from 'drizzle-orm';
import { db, type AppDatabase } from '@/lib/db';
import { entries } from '@/lib/db/schema';
import {
  decodeEntryCursor,
  encodeEntryCursor,
  type EntryCursor,
} from '@/lib/pagination';
import { normalizeSearchQuery } from '@/lib/validation';
import {
  entryTagNamesSql,
  hasAnyTag,
  parseTagNames,
} from '@/lib/db/entry-tags';
import { messages } from '@/lib/messages';
import { recoverStalePendingEntriesThrottled } from '@/lib/ai/stale-pending';
import { after } from 'next/server';
import { activeEntries } from '@/lib/db/entry-scope';
import { getFieldCipher } from '@/lib/crypto/cipher';
import { encryptLegacyRowsInBackground } from '@/lib/crypto/backfill';
import type { FieldCipher } from '@/lib/crypto/field-cipher';

export const DASHBOARD_PREVIEW_LENGTH = 280;

/**
 * Recovery is a write, and this is a read path, so it must not sit in front of
 * the response. after() runs it once the page has been sent.
 */
function scheduleRecovery(database: AppDatabase) {
  try {
    after(() => recoverStalePendingEntriesThrottled(database));
    after(() => encryptLegacyRowsInBackground(database));
  } catch {
    // after() is only available inside a request; tests call these loaders
    // directly, where skipping the sweep is correct.
  }
}
// Characters of lead-in kept before a search hit, so the match lands in view
// with some context rather than at the very start of the snippet.
const SEARCH_SNIPPET_LEAD = 60;

/**
 * Rows decrypted per round trip while searching. Search runs in JS because
 * the database only holds ciphertext; batching keeps the first page from
 * reading the whole diary when matches are common.
 */
const SEARCH_BATCH_SIZE = 200;

/** First `length` characters, counted in code points like SQL left(). */
function leftChars(value: string, length: number) {
  return Array.from(value).slice(0, length).join('');
}

/**
 * The preview column.
 *
 * Without a query this is the summary (falling back to the body). With one it
 * becomes a window around the first match in the body, because a keyword that
 * hits at character 3000 is invisible in a summary prefix and the result looks
 * unrelated to what was typed.
 */
function buildPreview(
  { content, summary }: { content: string | null; summary: string | null },
  query?: string,
) {
  if (query && content) {
    const at = content.toLowerCase().indexOf(query.toLowerCase());
    if (at >= 0) {
      const chars = Array.from(content);
      const offset = Array.from(content.slice(0, at)).length;
      const from = Math.max(0, offset - SEARCH_SNIPPET_LEAD);
      return (
        (from > 0 ? '…' : '') +
        chars.slice(from, from + DASHBOARD_PREVIEW_LENGTH).join('')
      );
    }
  }
  return leftChars(summary ?? content ?? '', DASHBOARD_PREVIEW_LENGTH);
}

function matchesQuery(query: string, fields: Array<string | null | undefined>) {
  const needle = query.toLowerCase();
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

export type DashboardEntry = {
  id: string;
  title: string | null;
  preview: string;
  tags: string[];
  aiStatus: string | null;
  createdAt: Date;
  recordedAt: Date;
};

export type DashboardEntriesPage = {
  items: DashboardEntry[];
  pageInfo: {
    nextCursor: string | null;
    hasMore: boolean;
    limit: number;
  };
};

export type TimelineEntry = {
  id: string;
  displayTitle: string;
  displaySummary: string;
  statusLabel: string | null;
  statusTone: 'danger' | 'muted';
  tags: string[];
  createdAt: string;
  isPending: boolean;
};

export type TimelineEntriesPage = {
  items: TimelineEntry[];
  pageInfo: DashboardEntriesPage['pageInfo'];
};

export function buildTimelineEntriesPage(
  page: DashboardEntriesPage,
): TimelineEntriesPage {
  return {
    pageInfo: page.pageInfo,
    items: page.items.map((entry) => ({
      id: entry.id,
      displayTitle: entry.title || messages.dashboard.untitledEntry,
      displaySummary: entry.preview,
      tags: entry.tags,
      statusLabel:
        entry.aiStatus === 'failed'
          ? messages.common.failed
          : entry.aiStatus === 'pending'
            ? messages.common.processing
            : null,
      statusTone: entry.aiStatus === 'failed' ? 'danger' : 'muted',
      createdAt: entry.createdAt.toISOString(),
      isPending: entry.aiStatus === 'pending',
    })),
  };
}

type EntryFilters = { q?: string; tag?: string; cursor?: string };

function buildEntryWhere(
  cipher: FieldCipher,
  { tag, cursor }: { tag?: string; cursor?: EntryCursor },
) {
  const conditions: SQL[] = [];

  // Tag filtering runs in SQL against entry_tags_tag_id_entry_id_idx rather
  // than loading rows and filtering them in JS.
  if (tag) conditions.push(hasAnyTag(cipher, [tag]));

  if (cursor) {
    const cursorCondition = or(
      lt(entries.createdAt, cursor.createdAt),
      and(
        eq(entries.createdAt, cursor.createdAt),
        lt(entries.recordedAt, cursor.recordedAt),
      ),
      and(
        eq(entries.createdAt, cursor.createdAt),
        eq(entries.recordedAt, cursor.recordedAt),
        lt(entries.id, cursor.id),
      ),
    );
    if (cursorCondition) conditions.push(cursorCondition);
  }

  return activeEntries(...conditions);
}

const TIMELINE_ORDER = [
  desc(entries.createdAt),
  desc(entries.recordedAt),
  desc(entries.id),
];

function toPage<T extends EntryCursor>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    pageInfo: {
      hasMore,
      limit,
      nextCursor:
        hasMore && last
          ? encodeEntryCursor({
              createdAt: last.createdAt,
              recordedAt: last.recordedAt,
              id: last.id,
            })
          : null,
    },
  };
}

export async function loadDashboardEntriesPage(
  { q, tag, cursor, limit = 20 }: EntryFilters & { limit?: number },
  database: AppDatabase = db,
): Promise<DashboardEntriesPage> {
  scheduleRecovery(database);
  const query = normalizeSearchQuery(q);
  const cipher = await getFieldCipher(database);

  const decryptRow = (row: {
    id: string;
    title: string | null;
    summary: string | null;
    content: string | null;
    tags: string;
    aiStatus: string | null;
    createdAt: Date;
    recordedAt: Date;
  }) => ({
    id: row.id,
    title: cipher.decryptEntryField(row.id, 'title', row.title),
    summary: cipher.decryptEntryField(row.id, 'summary', row.summary),
    content: cipher.decryptEntryField(row.id, 'content', row.content),
    tags: parseTagNames(cipher, row.tags),
    aiStatus: row.aiStatus,
    createdAt: row.createdAt,
    recordedAt: row.recordedAt,
  });

  const selectRows = (after: EntryCursor | undefined, batch: number) =>
    database
      .select({
        id: entries.id,
        title: entries.title,
        summary: entries.summary,
        // Without a query the body only matters when there is no summary to
        // preview, so it is not fetched otherwise.
        content: query
          ? entries.content
          : sql<
              string | null
            >`case when ${entries.summary} is null then ${entries.content} end`,
        tags: entryTagNamesSql,
        aiStatus: entries.aiStatus,
        createdAt: entries.createdAt,
        recordedAt: entries.recordedAt,
      })
      .from(entries)
      .where(buildEntryWhere(cipher, { tag, cursor: after }))
      .orderBy(...TIMELINE_ORDER)
      .limit(batch);

  let rows: ReturnType<typeof decryptRow>[];
  if (!query) {
    rows = (await selectRows(decodeEntryCursor(cursor), limit + 1)).map(
      decryptRow,
    );
  } else {
    rows = [];
    let after = decodeEntryCursor(cursor);
    while (rows.length <= limit) {
      const batch = await selectRows(after, SEARCH_BATCH_SIZE);
      for (const raw of batch) {
        const row = decryptRow(raw);
        if (!matchesQuery(query, [row.content, row.title, row.summary]))
          continue;
        rows.push(row);
        if (rows.length > limit) break;
      }
      const last = batch.at(-1);
      if (batch.length < SEARCH_BATCH_SIZE || !last) break;
      after = last;
    }
  }

  const page = toPage(rows, limit);
  return {
    items: page.items.map((row) => ({
      id: row.id,
      title: row.title,
      preview: buildPreview(row, query),
      tags: row.tags,
      aiStatus: row.aiStatus,
      createdAt: row.createdAt,
      recordedAt: row.recordedAt,
    })),
    pageInfo: page.pageInfo,
  };
}

export async function loadApiEntriesPage(
  {
    cursor,
    limit,
  }: {
    cursor?: string;
    limit: number;
  },
  database: AppDatabase = db,
) {
  scheduleRecovery(database);
  const cipher = await getFieldCipher(database);
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
    .where(buildEntryWhere(cipher, { cursor: decodeEntryCursor(cursor) }))
    .orderBy(...TIMELINE_ORDER)
    .limit(limit + 1);
  const page = toPage(rows, limit);
  return {
    items: page.items.map((row) => ({
      ...row,
      content: cipher.decryptEntryField(row.id, 'content', row.content),
      title: cipher.decryptEntryField(row.id, 'title', row.title),
      summary: cipher.decryptEntryField(row.id, 'summary', row.summary),
      tags: parseTagNames(cipher, row.tags),
    })),
    pageInfo: page.pageInfo,
  };
}

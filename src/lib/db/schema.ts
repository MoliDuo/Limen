import {
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { normalizeToUtcDay } from '@/lib/entry-date';

export const entries = pgTable(
  'entries',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    content: text('content').notNull(),
    title: text('title'),
    summary: text('summary'),
    source: text('source').default('web'),
    aiStatus: text('ai_status').default('pending'),
    // Soft delete. Rows with a value live in the recycle bin for 30 days and
    // must be excluded from every user-facing read; see lib/db/entry-scope.ts.
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    // Set when the owner edits these by hand; the AI then stops overwriting
    // them. Timestamps rather than flags so "when" stays recoverable, and two
    // columns rather than one so renaming an entry does not also freeze its
    // tags.
    titleLockedAt: timestamp('title_locked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    tagsLockedAt: timestamp('tags_locked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: date('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => normalizeToUtcDay(new Date())),
    recordedAt: timestamp('recorded_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    // Partial on purpose: Postgres only uses these when the query carries a
    // matching `deleted_at IS NULL` predicate, so forgetting the filter costs
    // the index outright rather than merely showing deleted rows.
    index('entries_timeline_idx')
      .on(table.createdAt.desc(), table.recordedAt.desc(), table.id.desc())
      .where(sql`${table.deletedAt} is null`),
    index('entries_ai_status_updated_at_idx')
      .on(table.aiStatus, table.updatedAt)
      .where(sql`${table.deletedAt} is null`),
    index('entries_deleted_at_idx')
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} is not null`),
  ],
);

// `name` holds the encrypted tag name and `name_hmac` is the business key: a
// keyed hash of the plaintext name, so uniqueness and tag filters still run in
// SQL without the database ever seeing the name. The integer id never leaves
// the database.
export const tags = pgTable('tags', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  nameHmac: text('name_hmac').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const entryTags = pgTable(
  'entry_tags',
  {
    entryId: text('entry_id')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The composite key covers entry -> tags; the index covers tag -> entries.
    primaryKey({ columns: [table.entryId, table.tagId] }),
    index('entry_tags_tag_id_entry_id_idx').on(table.tagId, table.entryId),
  ],
);

export const authAttempts = pgTable(
  'auth_attempts',
  {
    key: text('key').primaryKey(),
    failures: integer('failures').notNull().default(0),
    windowStartedAt: timestamp('window_started_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    blockedUntil: timestamp('blocked_until', {
      withTimezone: true,
      mode: 'date',
    }),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (table) => [index('auth_attempts_updated_at_idx').on(table.updatedAt)],
);

export const settings = pgTable(
  'settings',
  {
    ownerId: text('owner_id').primaryKey(),
    theme: text('theme').notNull().default('system'),
    timeZone: text('time_zone').notNull().default('Asia/Shanghai'),
    editorFontSize: text('editor_font_size').notNull().default('medium'),
    defaultExportFormat: text('default_export_format')
      .notNull()
      .default('markdown'),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'settings_theme_check',
      sql`${table.theme} IN ('system', 'light', 'dark')`,
    ),
    check(
      'settings_editor_font_size_check',
      sql`${table.editorFontSize} IN ('small', 'medium', 'large')`,
    ),
    check(
      'settings_default_export_format_check',
      sql`${table.defaultExportFormat} IN ('markdown', 'json')`,
    ),
  ],
);

/**
 * Everything that can open the data key, each holding its own wrapped copy
 * (LUKS-style slots). Every slot wraps the same key, so changing the password,
 * signing in or revoking a token never re-encrypts an entry. See
 * docs/encryption.md for the exact format.
 *
 * - password: scrypt over the owner's password. Opening it is the login check.
 * - session: one per signed-in browser; the secret lives only in the cookie.
 * - api_token: one per API client; the secret lives only in the client.
 */
export const encryptionKeySlots = pgTable(
  'encryption_key_slots',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull().default('password'),
    kdf: text('kdf').notNull(),
    kdfParams: text('kdf_params').notNull(),
    salt: text('salt').notNull(),
    wrappedKey: text('wrapped_key').notNull(),
    label: text('label'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    lastUsedAt: timestamp('last_used_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'encryption_key_slots_kind_check',
      sql`${table.kind} IN ('password', 'session', 'api_token')`,
    ),
  ],
);

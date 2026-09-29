import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { encryptionKeySlots, entries, entryTags, tags } from '@/lib/db/schema';
import { FieldCipher, entryFieldAad } from '@/lib/crypto/field-cipher';
import { getFieldCipher } from '@/lib/crypto/cipher';
import {
  EncryptionKeyError,
  addPasswordSlot,
  countKeySlots,
  removeOtherPasswordSlots,
  unlockDataKey,
} from '@/lib/crypto/key-slots';
import { countLegacyRows, encryptLegacyRows } from '@/lib/crypto/backfill';
import { createAIProcessor } from '@/lib/ai/processor';
import { createEntryActions } from '@/lib/actions/entries-core';
import { findActiveEntry } from '@/lib/db/entries-repo';
import { listActiveTagNames, loadEntryTagsMap } from '@/lib/db/entry-tags';
import { loadDashboardEntriesPage } from '@/lib/dashboard-data';
import { loadExportEntries } from '@/lib/export-data';
import { createTestDb } from './helpers/test-db';
import { seedEntry } from './helpers/test-entries';

const PASSWORD = process.env.AUTH_PASSWORD as string;

test('a field decrypts only under the row and column it was written for', () => {
  const cipher = new FieldCipher(Buffer.alloc(32, 1));
  const sealed = cipher.encryptEntryField('a', 'content', '今天下雨');
  assert.match(sealed, /^enc:v1:/);
  assert.equal(cipher.decryptEntryField('a', 'content', sealed), '今天下雨');
  // Two encryptions of the same text differ: nothing to correlate.
  assert.notEqual(cipher.encryptEntryField('a', 'content', '今天下雨'), sealed);

  assert.throws(() => cipher.decryptEntryField('b', 'content', sealed));
  assert.throws(() => cipher.decryptEntryField('a', 'title', sealed));
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => cipher.decryptEntryField('a', 'content', tampered));
  assert.throws(() =>
    new FieldCipher(Buffer.alloc(32, 2)).decrypt(
      sealed,
      entryFieldAad('a', 'content'),
    ),
  );

  // Rows written before encryption read back as they are.
  assert.equal(cipher.decryptEntryField('a', 'content', 'plain'), 'plain');
  assert.equal(cipher.decryptEntryField('a', 'title', null), null);
});

test('tag hashes are stable per key and differ across keys', () => {
  const one = new FieldCipher(Buffer.alloc(32, 1));
  assert.equal(one.tagIndex('旅行'), one.tagIndex('旅行'));
  assert.notEqual(one.tagIndex('旅行'), one.tagIndex('工作'));
  assert.notEqual(
    one.tagIndex('旅行'),
    new FieldCipher(Buffer.alloc(32, 2)).tagIndex('旅行'),
  );
});

test('nothing the owner wrote reaches the database in plaintext', async () => {
  const fixture = await createTestDb();
  try {
    let job: (() => Promise<void>) | undefined;
    const processor = createAIProcessor({
      db: fixture.db,
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      title: '雨天散步',
                      summary: '下雨天去公园走了一圈',
                      tags: ['散步', '雨天'],
                    }),
                  },
                },
              ],
            }),
          },
        },
      },
    });
    const actions = createEntryActions({
      db: fixture.db,
      createId: () => 'secret',
      scheduleAI: (next) => {
        job = next;
      },
      processAIEntry: processor,
      revalidatePath: () => {},
    });
    const form = new FormData();
    form.set('content', '今天在公园里走了很久，雨一直没停。');
    form.set('createdAt', '2026-09-01');
    assert.equal((await actions.createEntry(form)).ok, true);
    await job?.();

    const words = ['公园', '雨天散步', '下雨天', '散步', '雨天'];
    const dump = JSON.stringify([
      await fixture.db.select().from(entries),
      await fixture.db.select().from(tags),
      await fixture.db.select().from(encryptionKeySlots),
    ]);
    for (const word of words) assert.equal(dump.includes(word), false, word);

    const entry = await findActiveEntry('secret', fixture.db);
    assert.equal(entry?.content, '今天在公园里走了很久，雨一直没停。');
    assert.equal(entry?.title, '雨天散步');
    assert.equal(entry?.summary, '下雨天去公园走了一圈');
    assert.deepEqual(entry?.tags, ['散步', '雨天']);
  } finally {
    await fixture.cleanup();
  }
});

test('the wrong password fails loudly and never mints a second key', async () => {
  const fixture = await createTestDb();
  try {
    const key = await unlockDataKey(fixture.db, PASSWORD);
    await assert.rejects(
      unlockDataKey(fixture.db, 'not-the-password'),
      EncryptionKeyError,
    );
    assert.equal(await countKeySlots(fixture.db), 1);
    assert.deepEqual(await unlockDataKey(fixture.db, PASSWORD), key);
  } finally {
    await fixture.cleanup();
  }
});

test('a lost slots table does not silently start a new key', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, { id: 'a', content: 'encrypted already' });
    await fixture.db.delete(encryptionKeySlots);
    await assert.rejects(
      unlockDataKey(fixture.db, PASSWORD),
      /Refusing to create a new key/,
    );
    assert.equal(await countKeySlots(fixture.db), 0);
  } finally {
    await fixture.cleanup();
  }
});

test('racing first unlocks agree on one key', async () => {
  const fixture = await createTestDb();
  try {
    const keys = await Promise.all([
      unlockDataKey(fixture.db, PASSWORD),
      unlockDataKey(fixture.db, PASSWORD),
      unlockDataKey(fixture.db, PASSWORD),
    ]);
    assert.deepEqual(keys[1], keys[0]);
    assert.deepEqual(keys[2], keys[0]);
    assert.equal(await countKeySlots(fixture.db), 1);
  } finally {
    await fixture.cleanup();
  }
});

test('changing the password re-wraps the key without touching entries', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, { id: 'a', content: 'kept across rotation' });
    const [before] = await fixture.db.select().from(entries);
    const key = await unlockDataKey(fixture.db, PASSWORD);

    assert.deepEqual(
      await addPasswordSlot(fixture.db, PASSWORD, 'new-password'),
      { added: true },
    );
    assert.deepEqual(
      await addPasswordSlot(fixture.db, PASSWORD, 'new-password'),
      { added: false },
    );
    // Both open it during the switch, so no deployment is ever locked out.
    assert.deepEqual(await unlockDataKey(fixture.db, 'new-password'), key);
    assert.deepEqual(await unlockDataKey(fixture.db, PASSWORD), key);

    assert.equal(
      (await removeOtherPasswordSlots(fixture.db, 'new-password')).removed,
      1,
    );
    await assert.rejects(
      unlockDataKey(fixture.db, PASSWORD),
      EncryptionKeyError,
    );
    const [after] = await fixture.db.select().from(entries);
    assert.equal(after.content, before.content);
    assert.equal(
      new FieldCipher(
        await unlockDataKey(fixture.db, 'new-password'),
      ).decryptEntryField('a', 'content', after.content),
      'kept across rotation',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('the backfill encrypts old rows in place and is safe to repeat', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, {
      id: 'old',
      content: 'written before encryption',
      title: 'old title',
      summary: 'old summary',
      deletedAt: new Date(),
      plaintext: true,
    });
    await seedEntry(fixture.db, {
      id: 'half',
      content: 'body without metadata',
      plaintext: true,
    });
    // A tag row from before encryption, and a second one whose encrypted twin
    // the new code has already created.
    const [legacy] = await fixture.db
      .insert(tags)
      .values([{ name: '旧标签' }, { name: '共用' }])
      .returning({ id: tags.id });
    await fixture.db
      .insert(entryTags)
      .values({ entryId: 'old', tagId: legacy.id });
    const [shared] = await fixture.db
      .select({ id: tags.id })
      .from(tags)
      .where(eq(tags.name, '共用'));
    await fixture.db
      .insert(entryTags)
      .values({ entryId: 'old', tagId: shared.id });
    await seedEntry(fixture.db, { id: 'new', tags: ['共用'] });

    assert.deepEqual(await countLegacyRows(fixture.db), {
      entries: 2,
      tags: 2,
    });
    assert.deepEqual(await encryptLegacyRows(fixture.db), {
      entries: 2,
      tags: 2,
      complete: true,
    });
    assert.deepEqual(await countLegacyRows(fixture.db), {
      entries: 0,
      tags: 0,
    });
    assert.deepEqual(await encryptLegacyRows(fixture.db), {
      entries: 0,
      tags: 0,
      complete: true,
    });

    const [old] = await fixture.db
      .select()
      .from(entries)
      .where(eq(entries.id, 'old'));
    for (const value of [old.content, old.title, old.summary]) {
      assert.match(value ?? '', /^enc:v1:/);
    }
    const cipher = await getFieldCipher(fixture.db);
    assert.equal(
      cipher.decryptEntryField('old', 'summary', old.summary),
      'old summary',
    );
    assert.equal(
      (await findActiveEntry('half', fixture.db))?.content,
      'body without metadata',
    );

    // The twin absorbed the legacy row: one tag, on both entries.
    const tagRows = await fixture.db.select().from(tags);
    assert.equal(tagRows.length, 2);
    assert.equal(
      tagRows.every((row) => row.nameHmac && row.name.startsWith('enc:v1:')),
      true,
    );
    const tagsById = await loadEntryTagsMap(fixture.db, ['old', 'new']);
    assert.deepEqual(tagsById.get('old'), ['共用', '旧标签']);
    assert.deepEqual(tagsById.get('new'), ['共用']);
  } finally {
    await fixture.cleanup();
  }
});

test('search, tag filters and export see through the encryption', async () => {
  const fixture = await createTestDb();
  try {
    const filler = 'x'.repeat(400);
    await seedEntry(fixture.db, {
      id: 'a',
      content: `${filler} the Needle is here`,
      summary: 'nothing to see',
      createdAt: new Date('2026-01-03'),
      tags: ['旅行'],
    });
    await seedEntry(fixture.db, {
      id: 'b',
      content: 'no match in this one',
      createdAt: new Date('2026-01-02'),
      tags: ['工作'],
    });
    await seedEntry(fixture.db, {
      id: 'c',
      content: 'plain body',
      title: 'needle in the title',
      createdAt: new Date('2026-01-01'),
      tags: ['旅行'],
    });

    const first = await loadDashboardEntriesPage(
      { q: 'needle', limit: 1 },
      fixture.db,
    );
    assert.deepEqual(
      first.items.map((item) => item.id),
      ['a'],
    );
    assert.match(first.items[0].preview, /^….*the Needle is here$/);
    assert.equal(first.pageInfo.hasMore, true);
    const second = await loadDashboardEntriesPage(
      { q: 'needle', limit: 1, cursor: first.pageInfo.nextCursor ?? '' },
      fixture.db,
    );
    assert.deepEqual(
      second.items.map((item) => item.id),
      ['c'],
    );
    assert.equal(second.pageInfo.hasMore, false);

    const byTag = await loadDashboardEntriesPage({ tag: '旅行' }, fixture.db);
    assert.deepEqual(
      byTag.items.map((item) => item.id),
      ['a', 'c'],
    );
    assert.equal(byTag.items[0].preview, 'nothing to see');

    assert.deepEqual(await listActiveTagNames(fixture.db), ['工作', '旅行']);
    const exported = await loadExportEntries(fixture.db, {
      format: 'json',
      tags: ['工作'],
    });
    assert.deepEqual(
      exported.map((entry) => [entry.id, entry.content, entry.tags]),
      [['b', 'no match in this one', ['工作']]],
    );
  } finally {
    await fixture.cleanup();
  }
});

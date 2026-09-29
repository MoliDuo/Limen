import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import {
  hasAnyTag,
  listActiveTagNames,
  loadEntryTagsMap,
  parseTagNames,
  syncEntryTags,
} from '@/lib/db/entry-tags';
import { entries } from '@/lib/db/schema';
import { createTestDb } from './helpers/test-db';
import { getFieldCipher } from '@/lib/crypto/cipher';
import { FieldCipher } from '@/lib/crypto/field-cipher';
import { seedEntry } from './helpers/test-entries';

async function tagsOf(fixture: { db: never }, id: string) {
  const map = await loadEntryTagsMap(fixture.db, [id]);
  return map.get(id) ?? [];
}

test('syncEntryTags adds, removes and converges', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, { id: 'e1' });
    await syncEntryTags(fixture.db, 'e1', ['beta', 'alpha']);
    assert.deepEqual(await tagsOf(fixture as never, 'e1'), ['alpha', 'beta']);

    await syncEntryTags(fixture.db, 'e1', ['alpha', 'gamma']);
    assert.deepEqual(await tagsOf(fixture as never, 'e1'), ['alpha', 'gamma']);

    await syncEntryTags(fixture.db, 'e1', []);
    assert.deepEqual(await tagsOf(fixture as never, 'e1'), []);
  } finally {
    await fixture.cleanup();
  }
});

test('syncEntryTags is idempotent and normalizes its input', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, { id: 'e1' });
    const messy = ['  spaced  ', '', 'dup', 'dup', 'x'.repeat(60)];
    await syncEntryTags(fixture.db, 'e1', messy);
    const first = await tagsOf(fixture as never, 'e1');
    await syncEntryTags(fixture.db, 'e1', messy);
    assert.deepEqual(await tagsOf(fixture as never, 'e1'), first);
    assert.deepEqual(first, ['dup', 'spaced', 'x'.repeat(50)]);
  } finally {
    await fixture.cleanup();
  }
});

test('a locked entry keeps its tags when the ai writes back', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, { id: 'e1' });
    await syncEntryTags(fixture.db, 'e1', ['mine'], { respectLock: false });
    await fixture.db
      .update(entries)
      .set({ tagsLockedAt: new Date() })
      .where(eq(entries.id, 'e1'));

    // The AI processor is the only caller that respects the lock.
    await syncEntryTags(fixture.db, 'e1', ['robot']);
    assert.deepEqual(await tagsOf(fixture as never, 'e1'), ['mine']);

    // Manual edits bypass it.
    await syncEntryTags(fixture.db, 'e1', ['mine', 'also-mine'], {
      respectLock: false,
    });
    assert.deepEqual(await tagsOf(fixture as never, 'e1'), [
      'also-mine',
      'mine',
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test('clearing tags on a locked entry is also blocked', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, { id: 'e1' });
    await syncEntryTags(fixture.db, 'e1', ['mine'], { respectLock: false });
    await fixture.db
      .update(entries)
      .set({ tagsLockedAt: new Date() })
      .where(eq(entries.id, 'e1'));
    // The delete half must honour the lock too, or an empty AI result would
    // silently wipe hand-picked tags.
    await syncEntryTags(fixture.db, 'e1', []);
    assert.deepEqual(await tagsOf(fixture as never, 'e1'), ['mine']);
  } finally {
    await fixture.cleanup();
  }
});

test('loadEntryTagsMap answers for every requested id', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, { id: 'tagged' });
    await seedEntry(fixture.db, { id: 'bare' });
    await syncEntryTags(fixture.db, 'tagged', ['one']);
    const map = await loadEntryTagsMap(fixture.db, [
      'tagged',
      'bare',
      'missing',
    ]);
    assert.deepEqual(map.get('tagged'), ['one']);
    assert.deepEqual(map.get('bare'), []);
    assert.deepEqual(map.get('missing'), []);
    assert.deepEqual(await loadEntryTagsMap(fixture.db, []), new Map());
  } finally {
    await fixture.cleanup();
  }
});

test('listActiveTagNames deduplicates and sorts for Chinese', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, { id: 'a' });
    await seedEntry(fixture.db, { id: 'b' });
    await syncEntryTags(fixture.db, 'a', ['旅行', '工作']);
    await syncEntryTags(fixture.db, 'b', ['旅行']);
    assert.deepEqual(await listActiveTagNames(fixture.db), ['工作', '旅行']);
  } finally {
    await fixture.cleanup();
  }
});

test('hasAnyTag matches any of the given names', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, { id: 'a' });
    await seedEntry(fixture.db, { id: 'b' });
    await seedEntry(fixture.db, { id: 'c' });
    await syncEntryTags(fixture.db, 'a', ['alpha']);
    await syncEntryTags(fixture.db, 'b', ['beta']);

    const rows = await fixture.db
      .select({ id: entries.id })
      .from(entries)
      .where(hasAnyTag(await getFieldCipher(fixture.db), ['alpha', 'beta']))
      .orderBy(entries.id);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['a', 'b'],
    );
  } finally {
    await fixture.cleanup();
  }
});

test('parseTagNames tolerates whatever the database returns', () => {
  const cipher = new FieldCipher(Buffer.alloc(32, 7));
  const stored = JSON.stringify([
    cipher.encryptTagName('b'),
    cipher.encryptTagName('a'),
  ]);
  assert.deepEqual(parseTagNames(cipher, stored), ['a', 'b']);
  // Rows the encryption backfill has not reached yet.
  assert.deepEqual(parseTagNames(cipher, '["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseTagNames(cipher, '[]'), []);
  assert.deepEqual(parseTagNames(cipher, null), []);
  assert.deepEqual(parseTagNames(cipher, '{broken'), []);
});

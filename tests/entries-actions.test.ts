import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createEntryActions } from '@/lib/actions/entries-core';
import { entries } from '@/lib/db/schema';
import { createTestDb } from './helpers/test-db';
import { readStoredEntry } from './helpers/test-entries';

function form(content: string, createdAt = '2024-01-03') {
  const data = new FormData();
  data.set('content', content);
  data.set('createdAt', createdAt);
  return data;
}

test('createEntry returns a structured validation error', async () => {
  const fixture = await createTestDb();
  try {
    const actions = createEntryActions({
      db: fixture.db,
      createId: () => 'unused',
      scheduleAI: () => {},
      processAIEntry: async () => {},
      revalidatePath: () => {},
    });
    assert.deepEqual(await actions.createEntry(form('   ')), {
      ok: false,
      error: '内容不能为空',
    });
  } finally {
    await fixture.cleanup();
  }
});

test('entry mutations authorize before touching the database', async () => {
  const fixture = await createTestDb();
  try {
    const actions = createEntryActions({
      db: fixture.db,
      createId: () => 'unauthorized',
      scheduleAI: () => {},
      processAIEntry: async () => {},
      revalidatePath: () => {},
      authorize: () => {
        throw new Error('Unauthorized');
      },
    });
    await assert.rejects(
      () => actions.createEntry(form('must not be inserted')),
      /Unauthorized/,
    );
    assert.equal(await fixture.db.$count(entries), 0);
  } finally {
    await fixture.cleanup();
  }
});

test('createEntry returns navigation data and schedules AI', async () => {
  const fixture = await createTestDb();
  let scheduled: (() => Promise<void>) | undefined;
  let processed: { id: string; content: string } | undefined;
  try {
    const actions = createEntryActions({
      db: fixture.db,
      createId: () => 'entry-created',
      scheduleAI: (job) => {
        scheduled = job;
      },
      processAIEntry: async (id, content) => {
        processed = { id, content };
      },
      revalidatePath: () => {},
    });
    assert.deepEqual(await actions.createEntry(form('Ship feedback')), {
      ok: true,
      data: { id: 'entry-created', redirectTo: '/' },
    });
    const row = await fixture.db.query.entries.findFirst({
      where: eq(entries.id, 'entry-created'),
    });
    assert.equal(row?.aiStatus, 'pending');
    await scheduled?.();
    assert.deepEqual(processed, {
      id: 'entry-created',
      content: 'Ship feedback',
    });
  } finally {
    await fixture.cleanup();
  }
});

test('createEntry marks the record failed when scheduling throws', async () => {
  const fixture = await createTestDb();
  try {
    const actions = createEntryActions({
      db: fixture.db,
      createId: () => 'schedule-failed',
      scheduleAI: () => {
        throw new Error('scheduler unavailable');
      },
      processAIEntry: async () => {},
      revalidatePath: () => {},
    });
    const result = await actions.createEntry(form('Still saved'));
    assert.equal(result.ok, true);
    const row = await fixture.db.query.entries.findFirst({
      where: eq(entries.id, 'schedule-failed'),
    });
    assert.equal(row?.aiStatus, 'failed');
  } finally {
    await fixture.cleanup();
  }
});

test('updateEntry keeps existing ai metadata and returns detail navigation', async () => {
  const fixture = await createTestDb();
  try {
    await fixture.db.insert(entries).values({
      id: 'entry-update',
      content: 'Old',
      title: 'Old',
      summary: 'Old',
      aiStatus: 'done',
      createdAt: new Date('2024-01-01'),
    });
    const { loadEntryTagsMap, syncEntryTags } =
      await import('@/lib/db/entry-tags');
    await syncEntryTags(fixture.db, 'entry-update', ['old']);
    const actions = createEntryActions({
      db: fixture.db,
      createId: () => 'unused',
      scheduleAI: () => {},
      processAIEntry: async () => {},
      revalidatePath: () => {},
    });
    assert.deepEqual(
      await actions.updateEntry('entry-update', form('New', '2024-01-02')),
      {
        ok: true,
        data: { id: 'entry-update', redirectTo: '/entries/entry-update' },
      },
    );
    const row = await readStoredEntry(fixture.db, 'entry-update');
    assert.equal(row?.content, 'New');
    assert.equal(row?.aiStatus, 'pending');
    // Held until the AI replaces them, so a failed regeneration cannot wipe
    // an entry's title and summary.
    assert.equal(row?.title, 'Old');
    assert.equal(row?.summary, 'Old');
    assert.deepEqual(
      (await loadEntryTagsMap(fixture.db, ['entry-update'])).get(
        'entry-update',
      ),
      ['old'],
    );
  } finally {
    await fixture.cleanup();
  }
});

test('a failed ai run after an edit leaves the old title and summary intact', async () => {
  const fixture = await createTestDb();
  try {
    await fixture.db.insert(entries).values({
      id: 'entry-ai-fails',
      content: 'Old body',
      title: 'A good title',
      summary: 'A good summary',
      aiStatus: 'done',
      createdAt: new Date('2024-01-01'),
    });
    let scheduled: (() => Promise<void>) | undefined;
    const actions = createEntryActions({
      db: fixture.db,
      createId: () => 'unused',
      scheduleAI: (job) => {
        scheduled = job;
      },
      // Mirrors createAIProcessor's failure path.
      processAIEntry: async (id) => {
        await fixture.db
          .update(entries)
          .set({ aiStatus: 'failed', updatedAt: new Date() })
          .where(eq(entries.id, id));
      },
      revalidatePath: () => {},
    });

    await actions.updateEntry('entry-ai-fails', form('New body', '2024-01-02'));
    await scheduled?.();

    const row = await readStoredEntry(fixture.db, 'entry-ai-fails');
    assert.equal(row?.aiStatus, 'failed');
    assert.equal(row?.content, 'New body');
    assert.equal(row?.title, 'A good title');
    assert.equal(row?.summary, 'A good summary');
  } finally {
    await fixture.cleanup();
  }
});

test('delete and regenerate return structured results', async () => {
  const fixture = await createTestDb();
  try {
    await fixture.db.insert(entries).values([
      { id: 'delete-me', content: 'Delete', createdAt: new Date('2024-01-01') },
      {
        id: 'regenerate-me',
        content: 'Regenerate',
        aiStatus: 'failed',
        createdAt: new Date('2024-01-02'),
      },
    ]);
    const actions = createEntryActions({
      db: fixture.db,
      createId: () => 'unused',
      scheduleAI: () => {},
      processAIEntry: async () => {},
      revalidatePath: () => {},
    });
    assert.deepEqual(await actions.deleteEntry('delete-me'), {
      ok: true,
      // The title rides along so the undo toast can name the entry.
      data: { id: 'delete-me', title: null, redirectTo: '/' },
    });
    assert.deepEqual(await actions.regenerateEntryMetadata('regenerate-me'), {
      ok: true,
      data: { id: 'regenerate-me' },
    });
    assert.equal(
      (
        await fixture.db.query.entries.findFirst({
          where: eq(entries.id, 'regenerate-me'),
        })
      )?.aiStatus,
      'pending',
    );
  } finally {
    await fixture.cleanup();
  }
});

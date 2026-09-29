import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { entries } from '@/lib/db/schema';
import type { AppDatabase } from '@/lib/db';
import { createTestDb } from './helpers/test-db';
import { seedEntry, readStoredEntry } from './helpers/test-entries';

const DELETED_AT = new Date('2026-09-01T00:00:00.000Z');

async function withTrashedEntry(
  run: (db: AppDatabase) => Promise<void>,
  overrides: Partial<typeof entries.$inferInsert> = {},
) {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, {
      id: 'trashed',
      content: 'in the bin',
      title: 'Trashed',
      aiStatus: 'done',
      tags: ['ghost'],
      ...overrides,
    });
    await seedEntry(fixture.db, {
      id: 'visible',
      content: 'still here',
      title: 'Visible',
      aiStatus: 'done',
      tags: ['real'],
    });
    await fixture.db
      .update(entries)
      .set({ deletedAt: DELETED_AT })
      .where(eq(entries.id, 'trashed'));
    await run(fixture.db);
  } finally {
    await fixture.cleanup();
  }
}

test('the timeline hides trashed entries', async () => {
  await withTrashedEntry(async (db) => {
    const { loadDashboardEntriesPage } = await import('@/lib/dashboard-data');
    const page = await loadDashboardEntriesPage({}, db);
    assert.deepEqual(
      page.items.map((entry) => entry.id),
      ['visible'],
    );
  });
});

test('the bearer list endpoint hides trashed entries', async () => {
  await withTrashedEntry(async (db) => {
    const { loadApiEntriesPage } = await import('@/lib/dashboard-data');
    const page = await loadApiEntriesPage({ limit: 20 }, db);
    assert.deepEqual(
      page.items.map((entry) => entry.id),
      ['visible'],
    );
  });
});

test('export skips trashed entries', async () => {
  await withTrashedEntry(async (db) => {
    const { loadExportEntries } = await import('@/lib/export-data');
    const rows = await loadExportEntries(db, {
      format: 'json',
      from: undefined,
      to: undefined,
      tags: [],
    });
    assert.deepEqual(
      rows.map((row) => row.id),
      ['visible'],
    );
  });
});

test('a trashed entry reads as missing for pages and the bearer detail route', async () => {
  await withTrashedEntry(async (db) => {
    const { findActiveEntry, findTrashedEntry } =
      await import('@/lib/db/entries-repo');
    assert.equal(await findActiveEntry('trashed', db), undefined);
    assert.ok(await findActiveEntry('visible', db));
    // The recycle bin still needs to reach it.
    assert.ok(await findTrashedEntry('trashed', db));
  });
});

test('ai polling stops following trashed entries', async () => {
  await withTrashedEntry(
    async (db) => {
      const { createBatchEntryStatusHandler } =
        await import('@/app/api/dashboard/entries/status/route');
      const POST = createBatchEntryStatusHandler({
        authorize: () => true,
        database: db,
        recoverPending: async () => {},
      });
      const response = await POST(
        new Request('http://localhost/status', {
          method: 'POST',
          body: JSON.stringify({ ids: ['trashed', 'visible'] }),
        }),
      );
      const body = (await response.json()) as {
        entries: Array<{ id: string }>;
      };
      assert.deepEqual(
        body.entries.map((entry) => entry.id),
        ['visible'],
      );
    },
    { aiStatus: 'pending' },
  );
});

test('stale-pending recovery leaves trashed entries alone', async () => {
  await withTrashedEntry(
    async (db) => {
      const { recoverStalePendingEntries } =
        await import('@/lib/ai/stale-pending');
      // Make the visible entry stale too, so the assertion is about the
      // trashed one being skipped rather than about nothing being stale.
      await db
        .update(entries)
        .set({
          aiStatus: 'pending',
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        })
        .where(eq(entries.id, 'visible'));
      const recovered = await recoverStalePendingEntries(
        db,
        new Date('2026-09-20T00:00:00.000Z'),
      );
      // Only the visible one; failing a trashed entry would churn updated_at
      // and reorder the recycle bin for no reason.
      assert.deepEqual(recovered, [{ id: 'visible' }]);
    },
    { aiStatus: 'pending', updatedAt: new Date('2026-08-01T00:00:00.000Z') },
  );
});

test('tags reachable only through the bin become invisible', async () => {
  await withTrashedEntry(async (db) => {
    const { listActiveTagNames } = await import('@/lib/db/entry-tags');
    // Otherwise a trashed entry's tags keep feeding the AI prompt and keep
    // appearing as export checkboxes that can never match anything.
    assert.deepEqual(await listActiveTagNames(db), ['real']);
  });
});

test('a trashed entry does not surface under its own tag', async () => {
  await withTrashedEntry(async (db) => {
    const { loadDashboardEntriesPage } = await import('@/lib/dashboard-data');
    const page = await loadDashboardEntriesPage({ tag: 'ghost' }, db);
    assert.deepEqual(page.items, []);
  });
});

test('a trashed entry cannot be edited or re-run through the ai', async () => {
  await withTrashedEntry(async (db) => {
    const { createEntryActions } = await import('@/lib/actions/entries-core');
    const actions = createEntryActions({
      db,
      createId: () => 'unused',
      scheduleAI: () => {},
      processAIEntry: async () => {},
      revalidatePath: () => {},
    });
    const form = new FormData();
    form.set('content', 'should not apply');
    form.set('createdAt', '2026-01-01');

    assert.equal((await actions.updateEntry('trashed', form)).ok, false);
    assert.equal((await actions.regenerateEntryMetadata('trashed')).ok, false);
    assert.equal((await actions.deleteEntry('trashed')).ok, false);
  });
});

test('an ai job finishing after a delete does not revive the entry', async () => {
  await withTrashedEntry(
    async (db) => {
      const { createAIProcessor } = await import('@/lib/ai/processor');
      const processor = createAIProcessor({
        db,
        client: {
          chat: {
            completions: {
              create: async () => ({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        title: 'Revived',
                        summary: 'Should not be written',
                        tags: ['nope'],
                      }),
                    },
                  },
                ],
              }),
            },
          },
        },
      });
      await processor('trashed', 'in the bin');

      const row = await readStoredEntry(db, 'trashed');
      assert.equal(row?.title, 'Trashed');
      assert.equal(row?.aiStatus, 'pending');
    },
    { aiStatus: 'pending' },
  );
});

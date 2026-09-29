import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { entries } from '@/lib/db/schema';
import { createTestDb } from './helpers/test-db';
import { seedEntry, readStoredEntry } from './helpers/test-entries';

test('processAIEntry marks an entry done with structured metadata on success', async () => {
  const fixture = await createTestDb();
  type AIRequest = { messages: Array<{ content: string }> };
  let capturedRequest: AIRequest | null = null;
  try {
    await seedEntry(fixture.db, {
      id: 'entry-success',
      content: 'Today I wrote tests.',
      aiStatus: 'pending',
      tags: ['journal', 'testing'],
    });

    const { createAIProcessor } = await import('@/lib/ai/processor');
    const processor = createAIProcessor({
      db: fixture.db,
      client: {
        chat: {
          completions: {
            create: async (input) => {
              capturedRequest = input;
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        title: '我今天重新把测试补好了',
                        summary: '我把测试重新补齐了，心里踏实了很多。',
                        tags: ['testing', 'journal'],
                      }),
                    },
                  },
                ],
              };
            },
          },
        },
      },
    });

    await processor('entry-success', 'Today I wrote tests.');

    const row = await readStoredEntry(fixture.db, 'entry-success');

    assert.equal(row?.aiStatus, 'done');
    assert.equal(row?.title, '我今天重新把测试补好了');
    assert.equal(row?.summary, '我把测试重新补齐了，心里踏实了很多。');
    // Tags now live in entry_tags; the AI writes them through syncEntryTags.
    const { loadEntryTagsMap } = await import('@/lib/db/entry-tags');
    const tagsById = await loadEntryTagsMap(fixture.db, ['entry-success']);
    assert.deepEqual(tagsById.get('entry-success'), ['journal', 'testing']);
    const request = capturedRequest as AIRequest | null;
    assert.ok(request);
    assert.match(request.messages[0].content, /第一人称|“我”的视角|现有标签/);
    assert.match(request.messages[0].content, /最多 10 个/);
    assert.match(request.messages[0].content, /journal, testing/);
  } finally {
    await fixture.cleanup();
  }
});

test('processAIEntry marks an entry failed when AI returns invalid JSON', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, {
      id: 'entry-failure',
      content: 'Broken response',
      aiStatus: 'pending',
    });

    const { createAIProcessor } = await import('@/lib/ai/processor');
    const processor = createAIProcessor({
      db: fixture.db,
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [{ message: { content: 'not-json' } }],
            }),
          },
        },
      },
    });

    await processor('entry-failure', 'Broken response');

    const row = await fixture.db.query.entries.findFirst({
      where: eq(entries.id, 'entry-failure'),
    });

    assert.equal(row?.aiStatus, 'failed');
    assert.equal(row?.title, null);
    assert.equal(row?.summary, null);
  } finally {
    await fixture.cleanup();
  }
});

test('long entries are processed in bounded chunks and summarized', async () => {
  const fixture = await createTestDb();
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  try {
    await seedEntry(fixture.db, {
      id: 'entry-long',
      content: 'x'.repeat(60_001),
      aiStatus: 'pending',
    });
    const { createAIProcessor } = await import('@/lib/ai/processor');
    const processor = createAIProcessor({
      db: fixture.db,
      client: {
        chat: {
          completions: {
            create: async () => {
              calls += 1;
              active += 1;
              maxActive = Math.max(maxActive, active);
              await new Promise<void>((resolve) => setImmediate(resolve));
              active -= 1;
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        title: '长文',
                        summary: '长文摘要',
                        tags: ['记录'],
                      }),
                    },
                  },
                ],
              };
            },
          },
        },
      },
    });
    await processor('entry-long', 'x'.repeat(60_001));
    assert.equal(calls, 4);
    assert.ok(maxActive <= 3);
    assert.equal(
      (
        await fixture.db.query.entries.findFirst({
          where: eq(entries.id, 'entry-long'),
        })
      )?.aiStatus,
      'done',
    );
  } finally {
    await fixture.cleanup();
  }
});

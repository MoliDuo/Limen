import test from 'node:test';
import assert from 'node:assert/strict';
import type { AIStatus } from '@/lib/ai/polling';
import { createTestDb } from './helpers/test-db';
import { seedEntry } from './helpers/test-entries';

async function requestStatus(status: AIStatus | undefined, authorized = true) {
  const { createEntryStatusHandler } =
    await import('@/app/api/dashboard/entries/[id]/status/route');
  const GET = createEntryStatusHandler({
    authorize: () => authorized,
    loadStatus: () => status,
  });
  return GET(
    new Request('http://localhost/api/dashboard/entries/entry/status'),
    {
      params: Promise.resolve({ id: 'entry' }),
    },
  );
}

for (const aiStatus of ['pending', 'done', 'failed'] as const) {
  test(`status endpoint returns ${aiStatus}`, async () => {
    const response = await requestStatus(aiStatus);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { aiStatus });
  });
}

test('status endpoint rejects an unauthenticated request', async () => {
  const response = await requestStatus('pending', false);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Unauthorized' });
});

test('status endpoint returns 404 for a missing entry', async () => {
  const response = await requestStatus(undefined);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Not Found' });
});

test('status endpoint preserves a null AI status', async () => {
  const response = await requestStatus(null);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { aiStatus: null });
});

test('batch status endpoint authenticates and validates ID lists', async () => {
  const fixture = await createTestDb();
  try {
    const { syncEntryTags } = await import('@/lib/db/entry-tags');
    await syncEntryTags(fixture.db, 'existing', ['one']);
    const { createBatchEntryStatusHandler } =
      await import('@/app/api/dashboard/entries/status/route');
    const unauthorized = createBatchEntryStatusHandler({
      authorize: () => false,
      database: fixture.db,
      recoverPending: async () => {},
    });
    assert.equal(
      (
        await unauthorized(
          new Request('http://localhost/status', {
            method: 'POST',
            body: JSON.stringify({ ids: ['entry'] }),
          }),
        )
      ).status,
      401,
    );

    const POST = createBatchEntryStatusHandler({
      authorize: () => true,
      database: fixture.db,
      recoverPending: async () => {},
    });
    for (const body of [
      'not-json',
      JSON.stringify({ ids: [] }),
      JSON.stringify({ ids: Array.from({ length: 101 }, () => 'entry') }),
      JSON.stringify({ ids: [1] }),
    ]) {
      const response = await POST(
        new Request('http://localhost/status', { method: 'POST', body }),
      );
      assert.equal(response.status, 400);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('batch status endpoint returns requested fields and omits missing IDs', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, {
      id: 'existing',
      content: 'content',
      title: 'Title',
      summary: 'Summary',
      aiStatus: 'done',
      createdAt: new Date('2026-08-19T00:00:00.000Z'),
      tags: ['one'],
    });
    const { createBatchEntryStatusHandler } =
      await import('@/app/api/dashboard/entries/status/route');
    const POST = createBatchEntryStatusHandler({
      authorize: () => true,
      database: fixture.db,
      recoverPending: async () => {},
    });
    const response = await POST(
      new Request('http://localhost/status', {
        method: 'POST',
        body: JSON.stringify({ ids: ['missing', 'existing'] }),
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      entries: [
        {
          id: 'existing',
          aiStatus: 'done',
          title: 'Title',
          summary: 'Summary',
          tags: ['one'],
        },
      ],
    });
  } finally {
    await fixture.cleanup();
  }
});

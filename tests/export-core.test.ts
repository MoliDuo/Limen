import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/test-db';
import { seedEntry } from './helpers/test-entries';
import {
  jsonExportChunks,
  markdownExportChunks,
  parseExportParameters,
  type ExportEntry,
} from '@/lib/export-core';
import { loadExportEntries } from '@/lib/export-data';

const baseEntry: ExportEntry = {
  id: 'entry-1',
  content: '# raw body\n\n--- stays raw',
  title: 'Title "quoted"',
  summary: 'Line one\nline two',
  tags: ['alpha', 'beta'],
  source: 'web',
  aiStatus: 'done',
  createdAt: new Date('2026-02-02T00:00:00Z'),
  recordedAt: new Date('2026-02-02T10:00:00Z'),
  updatedAt: new Date('2026-02-03T10:00:00Z'),
};

test('export parameters validate dates and retain repeated tags', () => {
  const filters = parseExportParameters(
    new URLSearchParams(
      'format=json&from=2026-01-01&to=2026-01-31&tags=a&tags=b',
    ),
  );
  assert.deepEqual(filters, {
    format: 'json',
    from: '2026-01-01',
    to: '2026-01-31',
    tags: ['a', 'b'],
  });
  assert.throws(() => parseExportParameters(new URLSearchParams('format=xml')));
  assert.throws(() =>
    parseExportParameters(new URLSearchParams('format=json&from=2026-02-30')),
  );
  assert.throws(() =>
    parseExportParameters(
      new URLSearchParams('format=json&from=2026-02-02&to=2026-02-01'),
    ),
  );
});

test('date filtering is inclusive and ordering is stable', async () => {
  const fixture = await createTestDb();
  try {
    for (const [id, day, hour] of [
      ['outside', '2026-01-31', 1],
      ['b', '2026-02-01', 2],
      ['a', '2026-02-01', 2],
      ['c', '2026-02-02', 1],
    ] as const) {
      await seedEntry(fixture.db, {
        id,
        content: id,
        createdAt: new Date(`${day}T00:00:00Z`),
        recordedAt: new Date(`${day}T0${hour}:00:00Z`),
      });
    }
    const rows = await loadExportEntries(fixture.db as never, {
      format: 'markdown',
      from: '2026-02-01',
      to: '2026-02-02',
      tags: [],
    });
    assert.deepEqual(
      rows.map((row) => row.id),
      ['a', 'b', 'c'],
    );
  } finally {
    await fixture.cleanup();
  }
});

test('tag filtering uses OR semantics and runs in SQL', async () => {
  // Previously every row was loaded and filtered in JS. It is now an indexed
  // EXISTS against entry_tags, so this has to be exercised against a database.
  const fixture = await createTestDb();
  try {
    const { syncEntryTags } = await import('@/lib/db/entry-tags');
    for (const [id, names] of [
      ['alpha-beta', ['alpha', 'beta']],
      ['gamma', ['gamma']],
      ['untagged', []],
    ] as const) {
      await seedEntry(fixture.db, {
        id,
        createdAt: new Date('2026-02-02T00:00:00Z'),
      });
      if (names.length > 0) await syncEntryTags(fixture.db, id, [...names]);
    }

    const matched = await loadExportEntries(fixture.db, {
      format: 'json',
      from: undefined,
      to: undefined,
      tags: ['beta', 'gamma'],
    });
    assert.deepEqual(
      matched.map((entry) => entry.id),
      ['alpha-beta', 'gamma'],
    );

    const all = await loadExportEntries(fixture.db, {
      format: 'json',
      from: undefined,
      to: undefined,
      tags: [],
    });
    assert.equal(all.length, 3);
    assert.deepEqual(all.find((entry) => entry.id === 'alpha-beta')?.tags, [
      'alpha',
      'beta',
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test('Markdown export escapes YAML and retains the raw body', () => {
  const text = Array.from(
    markdownExportChunks(
      [baseEntry],
      {
        format: 'markdown',
        from: '2026-02-01',
        to: undefined,
        tags: ['alpha'],
      },
      new Date('2026-03-01T00:00:00Z'),
    ),
  ).join('');
  assert.match(text, /条目数：1/);
  assert.match(text, /title: "Title \\"quoted\\""/);
  assert.match(text, /summary: "Line one\\nline two"/);
  assert.match(text, /---\nid:/);
  assert.ok(text.endsWith('# raw body\n\n--- stays raw\n'));
});

test('JSON export is versioned and preserves every backup field', () => {
  const text = Array.from(
    jsonExportChunks(
      [baseEntry],
      { format: 'json', tags: [], from: undefined, to: undefined },
      new Date('2026-03-01T00:00:00Z'),
    ),
  ).join('');
  const output = JSON.parse(text);
  // Bumped to 2: entries[].tags is now an array, not the stored JSON string.
  assert.equal(output.schemaVersion, 2);
  assert.equal(output.exportedAt, '2026-03-01T00:00:00.000Z');
  assert.deepEqual(Object.keys(output.entries[0]), [
    'id',
    'content',
    'title',
    'summary',
    'tags',
    'source',
    'aiStatus',
    'createdAt',
    'recordedAt',
    'updatedAt',
  ]);
  assert.deepEqual(output.entries[0].tags, ['alpha', 'beta']);
});

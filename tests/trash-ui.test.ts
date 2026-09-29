import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  UNDO_TOAST_DURATION_MS,
  buildDeletedToastMessage,
  createUndoHandler,
} from '@/lib/trash/undo-toast';
import { TRASH_RETENTION_MS } from '@/lib/trash/purge';
import { messages } from '@/lib/messages';
import { createEntryActions } from '@/lib/actions/entries-core';
import { createTestDb } from './helpers/test-db';
import { readStoredEntry, seedEntry } from './helpers/test-entries';

function read(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function actions(db: never) {
  return createEntryActions({
    db,
    createId: () => 'unused',
    scheduleAI: () => {},
    processAIEntry: async () => {},
    revalidatePath: () => {},
  });
}

test('the delete toast names the entry when it has a title', () => {
  assert.equal(
    buildDeletedToastMessage('周末的雨', messages),
    '已移至回收站：周末的雨',
  );
  assert.equal(buildDeletedToastMessage(null, messages), '记录已移至回收站');
  assert.equal(buildDeletedToastMessage('   ', messages), '记录已移至回收站');
});

test('undo restores, then refreshes', async () => {
  const calls: string[] = [];
  const undo = createUndoHandler({
    restore: async (id) => {
      calls.push(`restore:${id}`);
      return { ok: true, data: { id } };
    },
    refresh: () => calls.push('refresh'),
    notifySuccess: (message) => calls.push(`success:${message}`),
    notifyError: (message) => calls.push(`error:${message}`),
    copy: messages,
  });

  await undo('entry-1');
  assert.deepEqual(calls, ['restore:entry-1', 'refresh', 'success:记录已恢复']);
});

test('undo surfaces a failed restore and a thrown one', async () => {
  const errors: string[] = [];
  const base = {
    refresh: () => {},
    notifySuccess: () => {},
    notifyError: (message: string) => errors.push(message),
    copy: messages,
  };

  await createUndoHandler({
    ...base,
    restore: async () => ({ ok: false, error: '记录不存在' }),
  })('gone');
  await createUndoHandler({
    ...base,
    restore: async () => {
      throw new Error('network');
    },
  })('boom');

  assert.deepEqual(errors, ['记录不存在', '恢复失败，请重试']);
});

test('deleting from the detail page offers undo outside the transition', () => {
  const source = read('src/components/EntryDetailActions.tsx');
  assert.match(source, /restoreEntry/);
  assert.match(source, /router\.refresh\(\)/);
  assert.match(source, /action: \{/);
  assert.match(source, /UNDO_TOAST_DURATION_MS/);
  // The dialog no longer claims the delete is irreversible.
  assert.doesNotMatch(source, /删除后无法恢复/);
  assert.equal(UNDO_TOAST_DURATION_MS, 8_000);
});

test('the trash view model counts down and falls back to a title', async () => {
  const { buildTrashViewModel } =
    await import('@/app/(dashboard)/settings/trash/page');
  const now = new Date('2026-10-01T00:00:00.000Z');
  const model = buildTrashViewModel(
    [
      {
        id: 'a',
        title: null,
        preview: 'body',
        tags: [],
        deletedAt: new Date(now.getTime() - TRASH_RETENTION_MS * 2),
      },
      {
        id: 'b',
        title: 'Named',
        preview: 'body',
        tags: ['x'],
        deletedAt: now,
      },
    ],
    messages,
    now,
  );

  assert.equal(model.isEmpty, false);
  assert.equal(model.items[0].displayTitle, '未命名记录');
  // Clamped, never negative, even for something already past its purge date.
  assert.equal(model.items[0].expiresIn, '0 天后永久删除');
  assert.equal(model.items[1].displayTitle, 'Named');
  assert.equal(model.items[1].expiresIn, '30 天后永久删除');
  assert.equal(buildTrashViewModel([], messages, now).isEmpty, true);
});

test('the trash page purges expired entries before listing', () => {
  const source = read('src/app/(dashboard)/settings/trash/page.tsx');
  assert.match(source, /purgeExpiredEntries\(\)/);
  assert.match(source, /trashedEntries\(\)/);
});

test('restore returns an entry untouched and purge only accepts trashed rows', async () => {
  const fixture = await createTestDb();
  try {
    const locked = new Date('2026-01-01T00:00:00.000Z');
    await seedEntry(fixture.db, {
      id: 'e1',
      title: 'Kept',
      tags: ['mine'],
      tagsLockedAt: locked,
    });
    const entryActions = actions(fixture.db as never);

    // Purging something that is not in the bin must fail.
    assert.equal((await entryActions.purgeEntry('e1')).ok, false);

    assert.equal((await entryActions.deleteEntry('e1')).ok, true);
    assert.equal((await entryActions.restoreEntry('e1')).ok, true);

    const row = await readStoredEntry(fixture.db, 'e1');
    assert.equal(row?.deletedAt, null);
    assert.equal(row?.title, 'Kept');
    // A restore must not re-open hand-picked tags to the AI.
    assert.deepEqual(row?.tagsLockedAt, locked);
    // And it must not queue a regeneration.
    assert.equal(row?.aiStatus, 'pending');

    const { loadEntryTagsMap } = await import('@/lib/db/entry-tags');
    assert.deepEqual((await loadEntryTagsMap(fixture.db, ['e1'])).get('e1'), [
      'mine',
    ]);

    // Restoring twice is a no-op, not a silent success.
    assert.equal((await entryActions.restoreEntry('e1')).ok, false);
  } finally {
    await fixture.cleanup();
  }
});

test('deleting twice does not report a second success', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, { id: 'e1' });
    const entryActions = actions(fixture.db as never);
    assert.equal((await entryActions.deleteEntry('e1')).ok, true);
    assert.equal((await entryActions.deleteEntry('e1')).ok, false);
  } finally {
    await fixture.cleanup();
  }
});

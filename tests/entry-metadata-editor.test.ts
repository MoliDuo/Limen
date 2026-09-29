import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTagEditorModel,
  normalizeTitleInput,
  validateTagDraft,
} from '@/lib/entry-metadata-editor';
import { createEntryActions } from '@/lib/actions/entries-core';
import { createAIProcessor } from '@/lib/ai/processor';
import { loadEntryTagsMap } from '@/lib/db/entry-tags';
import { messages } from '@/lib/messages';
import { createTestDb } from './helpers/test-db';
import { readStoredEntry, seedEntry } from './helpers/test-entries';

function actions(db: never) {
  return createEntryActions({
    db,
    createId: () => 'unused',
    scheduleAI: () => {},
    processAIEntry: async () => {},
    revalidatePath: () => {},
  });
}

function aiProcessor(db: never, title: string, tags: string[]) {
  return createAIProcessor({
    db,
    client: {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title,
                    summary: 'AI summary',
                    tags,
                  }),
                },
              },
            ],
          }),
        },
      },
    },
  });
}

test('a tag draft is rejected for the same reasons the server would', () => {
  assert.equal(validateTagDraft('  ', []), 'empty');
  assert.equal(validateTagDraft('x'.repeat(51), []), 'too-long');
  assert.equal(validateTagDraft('dup', ['dup']), 'duplicate');
  assert.equal(
    validateTagDraft(
      'eleven',
      Array.from({ length: 10 }, (_, i) => `t${i}`),
    ),
    'limit-reached',
  );
  assert.equal(validateTagDraft('ok', ['other']), null);
});

test('the tag editor model reports why adding is blocked', () => {
  const at = (tags: string[], draft: string, locked = false) =>
    buildTagEditorModel({ tags, draft, locked, copy: messages });

  assert.equal(at([], 'new').canAdd, true);
  assert.equal(at([], '').canAdd, false);
  assert.equal(at(['dup'], 'dup').addDisabledReason, '标签已存在');
  assert.equal(at([], 'x'.repeat(51)).addDisabledReason, '标签最多 50 字');
  assert.equal(
    at(
      Array.from({ length: 10 }, (_, i) => `t${i}`),
      'more',
    ).addDisabledReason,
    '最多 10 个标签',
  );
  assert.equal(at(['a'], '').remaining, 9);
  assert.equal(at([], '', false).lockNotice, null);
  assert.equal(at([], '', true).lockNotice, '标签已手动编辑，AI 不会覆盖');
  assert.deepEqual(at(['x'], '').chips, [
    { name: 'x', removeLabel: '移除标签 x' },
  ]);
});

test('titles are trimmed, capped, and empty means no title', () => {
  assert.equal(normalizeTitleInput('  hello  '), 'hello');
  assert.equal(normalizeTitleInput('   '), null);
  assert.equal(normalizeTitleInput(42), null);
  assert.equal(normalizeTitleInput('x'.repeat(250))?.length, 200);
});

test('hand-picked tags survive an ai regeneration', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, { id: 'e1', content: 'body' });
    const entryActions = actions(fixture.db as never);

    assert.equal((await entryActions.setEntryTags('e1', ['mine'])).ok, true);
    await aiProcessor(fixture.db as never, 'AI title', ['robot'])('e1', 'body');

    assert.deepEqual((await loadEntryTagsMap(fixture.db, ['e1'])).get('e1'), [
      'mine',
    ]);
    // The rest of the lifecycle still completes.
    const row = await readStoredEntry(fixture.db, 'e1');
    assert.equal(row?.aiStatus, 'done');
    assert.equal(row?.summary, 'AI summary');
    assert.equal(row?.title, 'AI title');
  } finally {
    await fixture.cleanup();
  }
});

test('a hand-written title survives an ai regeneration', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, { id: 'e1', content: 'body' });
    const entryActions = actions(fixture.db as never);

    assert.equal((await entryActions.setEntryTitle('e1', '那天')).ok, true);
    await aiProcessor(fixture.db as never, 'AI title', ['robot'])('e1', 'body');

    const row = await readStoredEntry(fixture.db, 'e1');
    assert.equal(row?.title, '那天');
    // Locking the title must not also freeze the tags.
    assert.deepEqual((await loadEntryTagsMap(fixture.db, ['e1'])).get('e1'), [
      'robot',
    ]);
    assert.equal(row?.summary, 'AI summary');
  } finally {
    await fixture.cleanup();
  }
});

test('unlocking hands both fields back to the ai', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, { id: 'e1', content: 'body' });
    const entryActions = actions(fixture.db as never);
    await entryActions.setEntryTitle('e1', '我的标题');
    await entryActions.setEntryTags('e1', ['mine']);

    assert.equal((await entryActions.unlockEntryMetadata('e1')).ok, true);
    await aiProcessor(fixture.db as never, 'AI title', ['robot'])('e1', 'body');

    const row = await readStoredEntry(fixture.db, 'e1');
    assert.equal(row?.title, 'AI title');
    assert.deepEqual((await loadEntryTagsMap(fixture.db, ['e1'])).get('e1'), [
      'robot',
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test('metadata edits normalize input and refuse trashed entries', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, { id: 'e1', content: 'body' });
    const entryActions = actions(fixture.db as never);

    const result = await entryActions.setEntryTags('e1', [
      '  spaced  ',
      'dup',
      'dup',
      '',
    ]);
    assert.deepEqual(result.ok && result.data.tags, ['spaced', 'dup']);

    await entryActions.deleteEntry('e1');
    assert.equal((await entryActions.setEntryTags('e1', ['x'])).ok, false);
    assert.equal((await entryActions.setEntryTitle('e1', 'x')).ok, false);
    assert.equal((await entryActions.unlockEntryMetadata('e1')).ok, false);
  } finally {
    await fixture.cleanup();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SESSION_DURATION_SECONDS,
  SESSION_RENEW_THRESHOLD_SECONDS,
  shouldRenewSession,
} from '@/lib/auth/session';
import { computeCurrentStreak, computeWritingStats } from '@/lib/stats';
import { loadWritingStats } from '@/lib/stats-data';
import { shouldRunRecovery } from '@/lib/ai/stale-pending';
import { formatTimeForFilename } from '@/lib/format';
import { createTestDb } from './helpers/test-db';
import { seedEntry } from './helpers/test-entries';

const NOW = new Date('2026-09-21T12:00:00.000Z');

function expiringIn(seconds: number) {
  return {
    id: 'session',
    expiresAt: new Date(NOW.getTime() + seconds * 1_000),
  };
}

test('a session is renewed only in its final stretch', () => {
  // A fresh cookie should not be re-signed on every request.
  assert.equal(
    shouldRenewSession(expiringIn(SESSION_DURATION_SECONDS), NOW),
    false,
  );
  assert.equal(
    shouldRenewSession(expiringIn(SESSION_RENEW_THRESHOLD_SECONDS + 1), NOW),
    false,
  );
  assert.equal(
    shouldRenewSession(expiringIn(SESSION_RENEW_THRESHOLD_SECONDS - 1), NOW),
    true,
  );
  // Already expired: let it fail rather than silently extending it.
  assert.equal(shouldRenewSession(expiringIn(0), NOW), false);
  assert.equal(shouldRenewSession(expiringIn(-10), NOW), false);
  assert.equal(shouldRenewSession(null, NOW), false);
});

test('the proxy extends the cookie when a session is nearly out', () => {
  const source = readFileSync(
    new URL('../src/proxy.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /shouldRenewSession\(session\)/);
  assert.match(source, /renewSession\(db, session\)/);
  assert.match(source, /response\.cookies\.set\(/);
});

test('the writing streak counts back from today and tolerates yesterday', () => {
  assert.equal(computeCurrentStreak([], '2026-09-21'), 0);
  assert.equal(
    computeCurrentStreak(
      ['2026-09-21', '2026-09-20', '2026-09-19'],
      '2026-09-21',
    ),
    3,
  );
  // Not written yet today: yesterday still counts, so the streak is not shown
  // as already lost first thing in the morning.
  assert.equal(
    computeCurrentStreak(['2026-09-20', '2026-09-19'], '2026-09-21'),
    2,
  );
  // A two-day gap ends it.
  assert.equal(computeCurrentStreak(['2026-09-19'], '2026-09-21'), 0);
  // A gap in the middle stops the count there.
  assert.equal(
    computeCurrentStreak(['2026-09-21', '2026-09-19'], '2026-09-21'),
    1,
  );
  // Duplicate days are one day.
  assert.equal(
    computeCurrentStreak(
      ['2026-09-21', '2026-09-21', '2026-09-20'],
      '2026-09-21',
    ),
    2,
  );
});

test('stats pass totals through untouched', () => {
  assert.deepEqual(
    computeWritingStats(
      {
        totalEntries: 12,
        totalCharacters: 3400,
        entriesThisYear: 5,
        entryDates: ['2026-09-21'],
      },
      '2026-09-21',
    ),
    {
      totalEntries: 12,
      totalCharacters: 3400,
      entriesThisYear: 5,
      currentStreak: 1,
    },
  );
});

test('stats come from SQL aggregates and skip trashed entries', async () => {
  const fixture = await createTestDb();
  try {
    await seedEntry(fixture.db, {
      id: 'a',
      content: '12345',
      createdAt: new Date('2026-09-21T00:00:00Z'),
    });
    await seedEntry(fixture.db, {
      id: 'b',
      content: '123',
      createdAt: new Date('2026-09-20T00:00:00Z'),
    });
    await seedEntry(fixture.db, {
      id: 'old',
      content: '1',
      createdAt: new Date('2024-01-01T00:00:00Z'),
    });
    await seedEntry(fixture.db, { id: 'gone', content: '99999999' });
    const { createEntryActions } = await import('@/lib/actions/entries-core');
    await createEntryActions({
      db: fixture.db,
      createId: () => 'unused',
      scheduleAI: () => {},
      processAIEntry: async () => {},
      revalidatePath: () => {},
    }).deleteEntry('gone');

    const stats = await loadWritingStats(fixture.db, '2026-09-21');
    assert.equal(stats.totalEntries, 3);
    assert.equal(stats.totalCharacters, 9);
    assert.equal(stats.entriesThisYear, 2);
    assert.equal(stats.currentStreak, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('stale-pending recovery is throttled on read paths', () => {
  const now = 1_000_000;
  assert.equal(shouldRunRecovery(now, 0), true);
  assert.equal(shouldRunRecovery(now, now - 59_000), false);
  assert.equal(shouldRunRecovery(now, now - 61_000), true);
});

test('page reads schedule recovery instead of awaiting it', () => {
  // A write in front of the first byte costs a Neon round-trip on a driver
  // with no connection reuse.
  for (const [file, pattern] of [
    ['src/lib/dashboard-data.ts', /scheduleRecovery\(database, cipher\)/],
    [
      'src/app/(dashboard)/entries/[id]/page.tsx',
      /after\(\(\) => recoverStalePendingEntriesThrottled\(\)\)/,
    ],
  ] as const) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, pattern, file);
    assert.doesNotMatch(source, /await recoverStalePendingEntries\(/, file);
  }

  // The polling routes still recover synchronously; that is where freshness
  // actually matters.
  const statusRoute = readFileSync(
    new URL(
      '../src/app/api/dashboard/entries/[id]/status/route.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(statusRoute, /await recoverStalePendingEntries\(\)/);
});

test('export filenames carry the time in the saved zone', () => {
  assert.equal(
    formatTimeForFilename(new Date('2026-07-28T16:30:00Z'), 'Asia/Shanghai'),
    '0030',
  );
  assert.equal(
    formatTimeForFilename(new Date('2026-07-28T16:30:00Z'), 'UTC'),
    '1630',
  );
});

test('signing out moved off the header and onto settings', () => {
  const layout = readFileSync(
    new URL('../src/app/(dashboard)/layout.tsx', import.meta.url),
    'utf8',
  );
  const settings = readFileSync(
    new URL('../src/components/SettingsForm.tsx', import.meta.url),
    'utf8',
  );
  // It used to sit next to 新建, an easy mis-tap on mobile with no confirm.
  assert.doesNotMatch(layout, /LogoutButton/);
  assert.match(settings, /<LogoutButton \/>/);
});

test('the login form can reveal the password', () => {
  const source = readFileSync(
    new URL('../src/app/login/page.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /type=\{revealed \? 'text' : 'password'\}/);
  assert.match(source, /aria-pressed=\{revealed\}/);
});

import type { Metadata } from 'next';
import { db } from '@/lib/db';
import { listActiveTagNames } from '@/lib/db/entry-tags';
import { getSettings } from '@/lib/settings';
import { SettingsForm } from '@/components/SettingsForm';
import { messages } from '@/lib/messages';
import { loadWritingStats } from '@/lib/stats-data';
import { formatDateInTimeZone } from '@/lib/entry-date';
import { listApiTokens } from '@/lib/crypto/key-slots';

function formatTimestamp(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export const metadata: Metadata = { title: '设置' };

// Still used by the no-JavaScript fallback, which is redirected here.
const EXPORT_MESSAGES = messages.settings.exportFailed;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ export?: string }>;
}) {
  const [settings, availableTags, stats, tokens, query] = await Promise.all([
    getSettings(),
    listActiveTagNames(db),
    loadWritingStats(
      db,
      formatDateInTimeZone(new Date(), (await getSettings()).timeZone),
    ),
    listApiTokens(db),
    searchParams,
  ]);
  const apiTokens = tokens.map((token) => ({
    id: token.id,
    label: token.label ?? '未命名',
    createdAt: formatTimestamp(token.createdAt, settings.timeZone),
    lastUsedAt: token.lastUsedAt
      ? formatTimestamp(token.lastUsedAt, settings.timeZone)
      : null,
  }));
  const exportMessage =
    EXPORT_MESSAGES[query.export as keyof typeof EXPORT_MESSAGES];

  return (
    <div className="mx-auto max-w-2xl space-y-10">
      <h1 className="text-2xl font-semibold tracking-tight">设置</h1>
      {exportMessage ? (
        <p
          role="alert"
          className="rounded-md border border-warning/30 px-4 py-3 text-sm text-warning"
        >
          {exportMessage}
        </p>
      ) : null}
      <SettingsForm
        settings={settings}
        availableTags={availableTags}
        stats={stats}
        apiTokens={apiTokens}
      />
    </div>
  );
}

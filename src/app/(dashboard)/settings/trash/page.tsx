import type { Metadata } from 'next';
import Link from 'next/link';
import { desc } from 'drizzle-orm';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { db } from '@/lib/db';
import { entries } from '@/lib/db/schema';
import { entryTagNamesSql, parseTagNames } from '@/lib/db/entry-tags';
import { getFieldCipher } from '@/lib/crypto/cipher';
import { trashedEntries } from '@/lib/db/entry-scope';
import { daysUntilPurge, purgeExpiredEntries } from '@/lib/trash/purge';
import { formatAbsoluteDate } from '@/lib/format';
import { messages } from '@/lib/messages';
import { settingsPath } from '@/lib/pathname';
import { Button } from '@/components/ui/button';
import { TrashActions } from '@/components/TrashActions';

export const metadata: Metadata = { title: '回收站' };

type TrashRow = {
  id: string;
  title: string | null;
  preview: string;
  tags: string[];
  deletedAt: Date;
};

export function buildTrashViewModel(
  rows: TrashRow[],
  copy: typeof messages,
  now: Date,
) {
  return {
    isEmpty: rows.length === 0,
    items: rows.map((row) => ({
      id: row.id,
      displayTitle: row.title || copy.editor.untitledCapture,
      preview: row.preview,
      tags: row.tags,
      deletedOn: copy.trash.deletedOn(formatAbsoluteDate(row.deletedAt)),
      expiresIn: copy.trash.expiresIn(daysUntilPurge(row.deletedAt, now)),
    })),
  };
}

export default async function TrashPage() {
  // Inline, like recoverStalePendingEntries on the timeline: the bin must never
  // show something that should already be gone. This page is rarely opened, so
  // the cost does not matter, which is why the sweep is not on the hot path.
  await purgeExpiredEntries();

  const cipher = await getFieldCipher(db);
  const rows = await db
    .select({
      id: entries.id,
      title: entries.title,
      preview: entries.summary,
      content: entries.content,
      tags: entryTagNamesSql,
      deletedAt: entries.deletedAt,
    })
    .from(entries)
    .where(trashedEntries())
    .orderBy(desc(entries.deletedAt));

  const model = buildTrashViewModel(
    rows.map((row) => ({
      id: row.id,
      title: cipher.decryptEntryField(row.id, 'title', row.title),
      preview: (row.preview === null
        ? cipher.decryptEntryField(row.id, 'content', row.content)
        : cipher.decryptEntryField(row.id, 'summary', row.preview)
      ).slice(0, 200),
      tags: parseTagNames(cipher, row.tags),
      deletedAt: row.deletedAt as Date,
    })),
    messages,
    new Date(),
  );

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div className="space-y-4">
        <Button
          variant="ghost"
          size="icon"
          asChild
          className="-ml-3 text-muted hover:text-text"
        >
          <Link
            href={settingsPath()}
            aria-label={messages.trash.backToSettings}
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {messages.trash.title}
          </h1>
          <p className="text-sm text-muted">{messages.trash.description}</p>
        </div>
      </div>

      {model.isEmpty ? (
        <div className="flex min-h-60 flex-col items-center justify-center rounded-lg border border-dashed border-border text-center">
          <Trash2 className="h-5 w-5 text-muted" />
          <p className="mt-3 text-sm text-muted">{messages.trash.empty}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {model.items.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-3 py-5 md:flex-row md:items-center"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <h2 className="truncate text-base font-semibold text-text">
                  {item.displayTitle}
                </h2>
                <p className="line-clamp-2 text-sm leading-6 text-muted">
                  {item.preview}
                </p>
                <p className="font-mono text-xs text-muted">
                  {item.deletedOn} · {item.expiresIn}
                </p>
              </div>
              <TrashActions entryId={item.id} title={item.displayTitle} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

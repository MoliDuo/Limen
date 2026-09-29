'use client';

import { useActionState, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Download, Loader2, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { WritingStats } from '@/lib/stats';
import { LogoutButton } from '@/components/LogoutButton';
import {
  SecuritySettings,
  type ApiTokenSummary,
} from '@/components/SecuritySettings';
import { messages } from '@/lib/messages';
import { trashPath } from '@/lib/pathname';
import { saveSettings } from '@/lib/actions/settings';
import type { AppSettings } from '@/lib/settings-core';
import type { ActionResult } from '@/lib/actions/result';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const TIME_ZONES = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
];

const GROUPS = {
  theme: [
    ['system', '跟随系统'],
    ['light', '浅色'],
    ['dark', '深色'],
  ],
  editorFontSize: [
    ['small', '小'],
    ['medium', '中'],
    ['large', '大'],
  ],
  defaultExportFormat: [
    ['markdown', 'Markdown'],
    ['json', 'JSON'],
  ],
  format: [
    ['markdown', 'Markdown'],
    ['json', 'JSON'],
  ],
} as const;

function SegmentedControl({
  name,
  value,
  onChange,
}: {
  name: keyof typeof GROUPS;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="inline-flex max-w-full rounded-md bg-surface2 p-0.5">
      {GROUPS[name].map(([option, label]) => (
        <label key={option} className="cursor-pointer">
          <input
            className="peer sr-only"
            type="radio"
            name={name}
            value={option}
            checked={option === value}
            onChange={() => onChange(option)}
          />
          <span className="block rounded-sm px-3 py-1 text-sm text-muted transition-colors hover:text-text peer-checked:bg-bg peer-checked:font-medium peer-checked:text-text peer-checked:ring-1 peer-checked:ring-border peer-focus-visible:ring-2 peer-focus-visible:ring-ring/40">
            {label}
          </span>
        </label>
      ))}
    </div>
  );
}

export function SettingsForm({
  settings,
  availableTags,
  stats,
  apiTokens,
}: {
  settings: AppSettings;
  availableTags: string[];
  stats: WritingStats;
  apiTokens: ApiTokenSummary[];
}) {
  const [formSettings, setFormSettings] = useState(settings);
  const [isExporting, setIsExporting] = useState(false);
  const [exportFormat, setExportFormat] = useState(
    settings.defaultExportFormat,
  );

  /**
   * Progressive enhancement over the native GET form, which stays as the
   * no-JavaScript path. Submitting through fetch keeps the chosen date range
   * and tags on screen when the export turns up empty or fails — the redirect
   * used to throw the whole selection away.
   */
  async function downloadExport(event: FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    event.preventDefault();
    const params = new URLSearchParams(
      new FormData(form) as unknown as Record<string, string>,
    );
    setIsExporting(true);
    try {
      const response = await fetch(`/api/export?${params}`, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: keyof typeof messages.settings.exportFailed;
        } | null;
        toast.error(
          messages.settings.exportFailed[body?.error ?? 'error'] ??
            messages.settings.exportFailed.error,
        );
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download =
        response.headers
          .get('content-disposition')
          ?.match(/filename="([^"]+)"/)?.[1] ?? 'limen-export';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(messages.settings.exportFailed.error);
    } finally {
      setIsExporting(false);
    }
  }
  const [state, action, pending] = useActionState(
    async (
      previousState: ActionResult<AppSettings> | undefined,
      formData: FormData,
    ) => {
      const result = await saveSettings(previousState, formData);
      if (result.ok) {
        setFormSettings(result.data);
        setExportFormat(result.data.defaultExportFormat);
      }
      return result;
    },
    undefined,
  );
  return (
    <div className="space-y-14">
      <section aria-labelledby="stats-heading" className="space-y-5">
        <h2
          id="stats-heading"
          className="border-b border-border pb-2 font-mono text-xs text-muted"
        >
          {messages.stats.heading}
        </h2>
        <dl className="grid grid-cols-2 gap-y-6 sm:grid-cols-4">
          {(
            [
              [messages.stats.totalEntries, stats.totalEntries],
              [messages.stats.currentStreak, stats.currentStreak],
              [messages.stats.entriesThisYear, stats.entriesThisYear],
              [
                messages.stats.totalCharacters,
                stats.totalCharacters.toLocaleString('zh-CN'),
              ],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted">{label}</dt>
              <dd className="mt-1 font-mono text-3xl font-semibold tracking-tight tabular-nums text-text">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="appearance-heading" className="space-y-5">
        <h2
          id="appearance-heading"
          className="border-b border-border pb-2 font-mono text-xs text-muted"
        >
          外观与编辑
        </h2>
        <form action={action} className="space-y-6">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">主题</legend>
            <SegmentedControl
              name="theme"
              value={formSettings.theme}
              onChange={(theme) =>
                setFormSettings((current) => ({
                  ...current,
                  theme: theme as AppSettings['theme'],
                }))
              }
            />
          </fieldset>
          <div className="max-w-md space-y-2">
            <label htmlFor="settings-time-zone" className="text-sm font-medium">
              时区
            </label>
            <Input
              id="settings-time-zone"
              name="timeZone"
              value={formSettings.timeZone}
              onChange={(event) =>
                setFormSettings((current) => ({
                  ...current,
                  timeZone: event.target.value,
                }))
              }
              list="iana-time-zones"
              autoComplete="off"
              required
            />
            <datalist id="iana-time-zones">
              {TIME_ZONES.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <p className="text-xs leading-5 text-muted">
              时区用于确定今天、草稿时间和导出文件名；记录日期按日历日保存，不随时区变化。
            </p>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">编辑器字号</legend>
            <SegmentedControl
              name="editorFontSize"
              value={formSettings.editorFontSize}
              onChange={(editorFontSize) =>
                setFormSettings((current) => ({
                  ...current,
                  editorFontSize:
                    editorFontSize as AppSettings['editorFontSize'],
                }))
              }
            />
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">默认导出格式</legend>
            <SegmentedControl
              name="defaultExportFormat"
              value={formSettings.defaultExportFormat}
              onChange={(defaultExportFormat) =>
                setFormSettings((current) => ({
                  ...current,
                  defaultExportFormat:
                    defaultExportFormat as AppSettings['defaultExportFormat'],
                }))
              }
            />
          </fieldset>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              <Save />
              {pending ? '保存中' : '保存设置'}
            </Button>
            <p
              role={state && !state.ok ? 'alert' : 'status'}
              className={
                state && !state.ok
                  ? 'text-sm text-danger'
                  : 'text-sm text-muted'
              }
            >
              {state ? (state.ok ? '设置已保存' : state.error) : null}
            </p>
          </div>
        </form>
      </section>

      <section aria-labelledby="export-heading" className="space-y-5">
        <h2
          id="export-heading"
          className="border-b border-border pb-2 font-mono text-xs text-muted"
        >
          数据导出
        </h2>
        <form
          action="/api/export"
          method="get"
          onSubmit={downloadExport}
          className="space-y-6"
        >
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">格式</legend>
            <SegmentedControl
              name="format"
              value={exportFormat}
              onChange={(format) =>
                setExportFormat(format as AppSettings['defaultExportFormat'])
              }
            />
          </fieldset>
          <div className="grid max-w-xl gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-sm font-medium">
              <span>开始日期</span>
              <Input type="date" name="from" />
            </label>
            <label className="space-y-2 text-sm font-medium">
              <span>结束日期</span>
              <Input type="date" name="to" />
            </label>
          </div>
          {availableTags.length > 0 ? (
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">标签（任一匹配）</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-3">
                {availableTags.map((tag) => (
                  <label key={tag} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="tags"
                      value={tag}
                      className="size-4 accent-primary"
                    />
                    <span className="font-mono text-xs">#{tag}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <Button type="submit" disabled={isExporting}>
            {isExporting ? <Loader2 className="animate-spin" /> : <Download />}
            {isExporting ? messages.settings.exporting : '下载导出文件'}
          </Button>
        </form>
      </section>

      <section aria-labelledby="trash-heading" className="space-y-5">
        <h2
          id="trash-heading"
          className="border-b border-border pb-2 font-mono text-xs text-muted"
        >
          {messages.trash.title}
        </h2>
        <p className="text-sm text-muted">{messages.trash.description}</p>
        <Button variant="secondary" asChild>
          <Link href={trashPath()}>
            <Trash2 />
            {messages.trash.title}
          </Link>
        </Button>
      </section>

      <SecuritySettings tokens={apiTokens} />

      <section aria-labelledby="account-heading" className="space-y-5">
        <h2
          id="account-heading"
          className="border-b border-border pb-2 font-mono text-xs text-muted"
        >
          {messages.settings.signOutHeading}
        </h2>
        <LogoutButton />
      </section>
    </div>
  );
}

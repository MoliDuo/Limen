'use client';

import { useActionState, useRef, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  changePassword,
  createApiToken,
  revokeApiToken,
} from '@/lib/actions/security';
import type { ActionResult } from '@/lib/actions/result';
import {
  MAX_TOKEN_LABEL_LENGTH,
  MIN_PASSWORD_LENGTH,
  type CreatedApiToken,
} from '@/lib/security-core';
import { PendingActionButton } from '@/components/PendingActionButton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export type ApiTokenSummary = {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
};

const HEADING = 'border-b border-border pb-2 font-mono text-xs text-muted';

function PasswordForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(
    async (previous: ActionResult | undefined, formData: FormData) => {
      const result = await changePassword(previous, formData);
      if (result.ok) {
        formRef.current?.reset();
        toast.success('密码已修改，其他设备已退出登录');
      }
      return result;
    },
    undefined,
  );

  return (
    <form ref={formRef} action={action} className="max-w-md space-y-4">
      {/* Lets password managers file the new password under the right entry. */}
      <input
        type="text"
        name="username"
        autoComplete="username"
        value="limen"
        readOnly
        hidden
      />
      <div className="space-y-2">
        <label htmlFor="current-password" className="text-sm font-medium">
          当前密码
        </label>
        <Input
          id="current-password"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="new-password" className="text-sm font-medium">
          新密码
        </label>
        <Input
          id="new-password"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="confirm-password" className="text-sm font-medium">
          确认新密码
        </label>
        <Input
          id="confirm-password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
      </div>
      {state && !state.ok ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : <KeyRound />}
        修改密码
      </Button>
    </form>
  );
}

function NewTokenNotice({
  token,
  onDismiss,
}: {
  token: CreatedApiToken;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(token.token);
      setCopied(true);
      toast.success('已复制');
    } catch {
      toast.error('复制失败，请手动选中复制');
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface p-4">
      <p className="text-sm font-medium">
        「{token.label}」的令牌只显示这一次，请现在复制保存。
      </p>
      <code className="block break-all rounded-sm bg-surface2 px-3 py-2 font-mono text-xs select-all">
        {token.token}
      </code>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={copy}>
          {copied ? <Check /> : <Copy />}
          {copied ? '已复制' : '复制'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
          我已保存
        </Button>
      </div>
    </div>
  );
}

function ApiTokens({ tokens }: { tokens: ApiTokenSummary[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [state, action, pending] = useActionState(
    async (
      previous: ActionResult<CreatedApiToken> | undefined,
      formData: FormData,
    ) => {
      const result = await createApiToken(previous, formData);
      if (result.ok) {
        setCreated(result.data);
        formRef.current?.reset();
      }
      return result;
    },
    undefined,
  );

  async function revoke(token: ApiTokenSummary) {
    if (
      !window.confirm(`撤销「${token.label}」？使用它的客户端将无法再访问。`)
    ) {
      return;
    }
    try {
      const result = await revokeApiToken(token.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (created?.id === token.id) setCreated(null);
      toast.success('令牌已撤销');
    } catch {
      toast.error('撤销失败，请重试');
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-muted">
        供 iOS 快捷指令等外部客户端使用，放在请求头{' '}
        <code className="font-mono text-xs">
          Authorization: Bearer &lt;令牌&gt;
        </code>{' '}
        中。每个客户端单独生成一个，不用了就撤销。
      </p>

      {tokens.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {tokens.map((token) => (
            <li
              key={token.id}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{token.label}</p>
                <p className="text-xs text-muted">
                  创建于 {token.createdAt}
                  {' · '}
                  {token.lastUsedAt
                    ? `最近使用 ${token.lastUsedAt}`
                    : '尚未使用'}
                </p>
              </div>
              <PendingActionButton
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`撤销 ${token.label}`}
                action={() => revoke(token)}
                idleContent={
                  <>
                    <X />
                    撤销
                  </>
                }
                pendingContent={
                  <>
                    <Loader2 className="animate-spin" />
                    撤销
                  </>
                }
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">还没有令牌。</p>
      )}

      {created ? (
        <NewTokenNotice token={created} onDismiss={() => setCreated(null)} />
      ) : null}

      <form
        ref={formRef}
        action={action}
        className="flex max-w-md items-start gap-2"
      >
        <div className="flex-1 space-y-2">
          <label htmlFor="api-token-label" className="sr-only">
            令牌名称
          </label>
          <Input
            id="api-token-label"
            name="label"
            placeholder="名称，例如：iPhone 快捷指令"
            maxLength={MAX_TOKEN_LABEL_LENGTH}
            autoComplete="off"
            required
          />
          {state && !state.ok ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
        </div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <Plus />}
          生成令牌
        </Button>
      </form>
    </div>
  );
}

export function SecuritySettings({ tokens }: { tokens: ApiTokenSummary[] }) {
  return (
    <>
      <section aria-labelledby="password-heading" className="space-y-5">
        <h2 id="password-heading" className={HEADING}>
          主密码
        </h2>
        <p className="text-sm leading-6 text-muted">
          主密码既用于登录，也是日记内容的加密密钥。忘记后
          <strong className="font-medium text-text">
            无法找回，日记也无法解密
          </strong>
          ，请存进密码管理器。修改后，除当前设备外的所有登录都会退出。
        </p>
        <PasswordForm />
      </section>

      <section aria-labelledby="api-tokens-heading" className="space-y-5">
        <h2 id="api-tokens-heading" className={HEADING}>
          API 令牌
        </h2>
        <ApiTokens tokens={tokens} />
      </section>
    </>
  );
}

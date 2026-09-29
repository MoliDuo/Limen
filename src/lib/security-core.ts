import type { AppDatabase } from '@/lib/db';
import type { ActionResult } from '@/lib/actions/result';
import {
  changePassword,
  createCredentialSlot,
  deleteCredentialSlot,
  listApiTokens,
} from '@/lib/crypto/key-slots';
import { forgetCredentials, formatCredential } from '@/lib/auth/credentials';

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;
export const MAX_TOKEN_LABEL_LENGTH = 60;
export const MAX_API_TOKENS = 20;

type LoginLimit = { blocked: boolean; retryAfterSeconds: number };

type SecurityActionDeps = {
  db: AppDatabase;
  /** The signed-in browser session and the data key it opened. */
  authorize: () => Promise<{ sessionId: string; dataKey: Buffer }>;
  getRateLimit: (key: string) => Promise<LoginLimit>;
  recordFailure: (key: string) => Promise<LoginLimit>;
  clearFailures: (key: string) => Promise<void>;
  revalidatePath: (path: string) => void;
};

export type CreatedApiToken = { id: string; label: string; token: string };

function field(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

export function createSecurityActions({
  db,
  authorize,
  getRateLimit,
  recordFailure,
  clearFailures,
  revalidatePath,
}: SecurityActionDeps) {
  return {
    async changePassword(
      _previous: ActionResult | undefined,
      formData: FormData,
    ): Promise<ActionResult> {
      const { sessionId } = await authorize();
      const current = field(formData, 'currentPassword');
      const next = field(formData, 'newPassword');
      const confirm = field(formData, 'confirmPassword');

      if (next.length < MIN_PASSWORD_LENGTH) {
        return {
          ok: false,
          error: `新密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`,
        };
      }
      if (next.length > MAX_PASSWORD_LENGTH) {
        return { ok: false, error: '新密码太长' };
      }
      if (next !== confirm) {
        return { ok: false, error: '两次输入的新密码不一致' };
      }
      if (next === current) {
        return { ok: false, error: '新密码不能与当前密码相同' };
      }

      // A borrowed session should not become a password-guessing oracle.
      const limitKey = `change-password:${sessionId}`;
      const limit = await getRateLimit(limitKey);
      if (limit.blocked) {
        return {
          ok: false,
          error: '尝试次数过多，请稍后再试',
          retryAfterSeconds: limit.retryAfterSeconds,
        };
      }
      if (
        current.length === 0 ||
        current.length > MAX_PASSWORD_LENGTH ||
        !(await changePassword(db, current, next, { keepSessionId: sessionId }))
      ) {
        const failed = await recordFailure(limitKey);
        return {
          ok: false,
          error: '当前密码不正确',
          retryAfterSeconds: failed.blocked
            ? failed.retryAfterSeconds
            : undefined,
        };
      }
      await clearFailures(limitKey);
      forgetCredentials(db);
      return { ok: true, data: undefined };
    },

    async createApiToken(
      _previous: ActionResult<CreatedApiToken> | undefined,
      formData: FormData,
    ): Promise<ActionResult<CreatedApiToken>> {
      const { dataKey } = await authorize();
      const label = field(formData, 'label').trim();
      if (!label) return { ok: false, error: '请填写令牌名称' };
      if (label.length > MAX_TOKEN_LABEL_LENGTH) {
        return {
          ok: false,
          error: `名称不能超过 ${MAX_TOKEN_LABEL_LENGTH} 个字符`,
        };
      }
      if ((await listApiTokens(db)).length >= MAX_API_TOKENS) {
        return { ok: false, error: '令牌数量已达上限，请先撤销不用的令牌' };
      }
      const { id, secret } = await createCredentialSlot(
        db,
        dataKey,
        'api_token',
        { label },
      );
      revalidatePath('/settings');
      return {
        ok: true,
        data: { id, label, token: formatCredential('api_token', id, secret) },
      };
    },

    async revokeApiToken(id: string): Promise<ActionResult> {
      await authorize();
      if (typeof id !== 'string' || !id) {
        return { ok: false, error: '令牌不存在' };
      }
      const removed = await deleteCredentialSlot(db, 'api_token', id);
      forgetCredentials(db, [id]);
      revalidatePath('/settings');
      return removed
        ? { ok: true, data: undefined }
        : { ok: false, error: '令牌不存在或已撤销' };
    },
  };
}

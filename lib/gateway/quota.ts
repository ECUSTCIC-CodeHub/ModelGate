import { gatewayDb, type DbUser } from "@/lib/core/db";
import { getEffectiveLimits } from "@/lib/gateway/effective-limits";

export type QuotaInfo = {
  remaining_requests: number | null;
  remaining_tokens: number | null;
  period_remaining_requests: number | null;
  period_remaining_tokens: number | null;
  period_reset_at: string | null;
};

export function appendQuotaHeaders(headers: Record<string, string>, quota: QuotaInfo) {
  if (quota.remaining_requests !== null) {
    headers["X-Quota-Limit-Requests-Remaining"] = String(quota.remaining_requests);
  }
  if (quota.remaining_tokens !== null) {
    headers["X-Quota-Limit-Tokens-Remaining"] = String(quota.remaining_tokens);
  }
  if (quota.period_remaining_requests !== null) {
    headers["X-Period-Quota-Requests-Remaining"] = String(quota.period_remaining_requests);
  }
  if (quota.period_remaining_tokens !== null) {
    headers["X-Period-Quota-Tokens-Remaining"] = String(quota.period_remaining_tokens);
  }
  if (quota.period_reset_at) {
    headers["X-Period-Quota-Reset"] = quota.period_reset_at;
  }
}

function ensurePeriodReset(userId: number, period: number, resetAt: string | null): { period_used_tokens: number; period_used_requests: number; period_reset_at: string } {
  const now = new Date();
  if (resetAt && new Date(resetAt) > now) {
    const row = gatewayDb
      .prepare("SELECT period_used_tokens, period_used_requests, period_reset_at FROM users WHERE id = ?")
      .get(userId) as { period_used_tokens: number; period_used_requests: number; period_reset_at: string };
    return row;
  }
  const nextReset = new Date(now.getTime() + period * 1000).toISOString();
  const result = gatewayDb
    .prepare(
      `UPDATE users
       SET period_used_tokens = 0, period_used_requests = 0, period_reset_at = ?
       WHERE id = ? AND (period_reset_at IS NULL OR period_reset_at <= ?)`,
    )
    .run(nextReset, userId, now.toISOString());
  if (result.changes > 0) {
    return { period_used_tokens: 0, period_used_requests: 0, period_reset_at: nextReset };
  }
  return gatewayDb
    .prepare("SELECT period_used_tokens, period_used_requests, period_reset_at FROM users WHERE id = ?")
    .get(userId) as { period_used_tokens: number; period_used_requests: number; period_reset_at: string };
}

export function checkQuota(userId: number, estimatedTokens: number): { ok: false; reason: string; quota?: QuotaInfo } | { ok: true; quota: QuotaInfo } {
  const user = gatewayDb
    .prepare(`SELECT id, group_id, quota_tokens, quota_requests, used_tokens, used_requests,
              quota_period, period_quota_tokens, period_quota_requests,
              period_used_tokens, period_used_requests, period_reset_at,
              rpm, qps, tpm FROM users WHERE id = ? AND deleted_at IS NULL`)
    .get(userId) as
    | {
        id: number;
        group_id: number | null;
        quota_tokens: number | null;
        quota_requests: number | null;
        used_tokens: number;
        used_requests: number;
        quota_period: number | null;
        period_quota_tokens: number | null;
        period_quota_requests: number | null;
        period_used_tokens: number;
        period_used_requests: number;
        period_reset_at: string | null;
        rpm: number;
        qps: number;
        tpm: number;
      }
    | undefined;

  if (!user) {
    return { ok: false, reason: "用户不存在" };
  }

  const limits = getEffectiveLimits(user as DbUser);

  const quota: QuotaInfo = {
    remaining_requests: limits.quota_requests !== null ? Math.max(0, limits.quota_requests - user.used_requests) : null,
    remaining_tokens: limits.quota_tokens !== null ? Math.max(0, limits.quota_tokens - user.used_tokens) : null,
    period_remaining_requests: null,
    period_remaining_tokens: null,
    period_reset_at: null,
  };

  if (limits.quota_requests !== null && user.used_requests >= limits.quota_requests) {
    return { ok: false, reason: "请求配额已用尽", quota };
  }

  if (limits.quota_tokens !== null && user.used_tokens + estimatedTokens > limits.quota_tokens) {
    return { ok: false, reason: "Token 配额已用尽", quota };
  }

  if (limits.quota_period) {
    const period = ensurePeriodReset(userId, limits.quota_period, user.period_reset_at);
    quota.period_reset_at = period.period_reset_at;

    if (limits.period_quota_requests !== null) {
      quota.period_remaining_requests = Math.max(0, limits.period_quota_requests - period.period_used_requests);
      if (period.period_used_requests >= limits.period_quota_requests) {
        return { ok: false, reason: "周期请求配额已用尽", quota };
      }
    }

    if (limits.period_quota_tokens !== null) {
      quota.period_remaining_tokens = Math.max(0, limits.period_quota_tokens - period.period_used_tokens);
      if (period.period_used_tokens + estimatedTokens > limits.period_quota_tokens) {
        return { ok: false, reason: "周期 Token 配额已用尽", quota };
      }
    }
  }

  return { ok: true, quota };
}

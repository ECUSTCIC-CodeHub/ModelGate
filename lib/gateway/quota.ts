import { gatewayDb, type DbUser } from "@/lib/core/db";
import { getEffectiveLimits } from "@/lib/gateway/effective-limits";
import { resolveStoredPeriodCycles, type PeriodCycle } from "@/lib/gateway/period-cycles";
import { ensureCycleResets } from "@/lib/gateway/period-cycles-reset";
import { formatPeriodLabel } from "@/lib/shared/period-format";

export type PeriodQuotaEntry = {
  id: string;
  period_seconds: number;
  period_label: string;
  quota_tokens: number | null;
  quota_requests: number | null;
  used_tokens: number;
  used_requests: number;
  remaining_tokens: number | null;
  remaining_requests: number | null;
  reset_at: string | null;
};

export type QuotaInfo = {
  remaining_requests: number | null;
  remaining_tokens: number | null;
  periods: PeriodQuotaEntry[];
};

// 旧的单档响应头保留，取「最先触发」的档位，避免老客户端读到空值。
function firstConfigured(periods: PeriodQuotaEntry[]): PeriodQuotaEntry | null {
  return periods.length > 0 ? periods[0] : null;
}

export function appendQuotaHeaders(headers: Record<string, string>, quota: QuotaInfo) {
  if (quota.remaining_requests !== null) {
    headers["X-Quota-Limit-Requests-Remaining"] = String(quota.remaining_requests);
  }
  if (quota.remaining_tokens !== null) {
    headers["X-Quota-Limit-Tokens-Remaining"] = String(quota.remaining_tokens);
  }
  const head = firstConfigured(quota.periods);
  if (head) {
    if (head.remaining_requests !== null) {
      headers["X-Period-Quota-Requests-Remaining"] = String(head.remaining_requests);
    }
    if (head.remaining_tokens !== null) {
      headers["X-Period-Quota-Tokens-Remaining"] = String(head.remaining_tokens);
    }
    if (head.reset_at) {
      headers["X-Period-Quota-Reset"] = head.reset_at;
    }
  }
  for (const period of quota.periods) {
    if (period.remaining_requests !== null) {
      headers[`X-Period-Quota-Requests-Remaining-${period.id}`] = String(period.remaining_requests);
    }
    if (period.remaining_tokens !== null) {
      headers[`X-Period-Quota-Tokens-Remaining-${period.id}`] = String(period.remaining_tokens);
    }
    if (period.reset_at) {
      headers[`X-Period-Quota-Reset-${period.id}`] = period.reset_at;
    }
  }
}

export function toPeriodQuotaEntry(cycle: PeriodCycle): PeriodQuotaEntry {
  return {
    id: cycle.id,
    period_seconds: cycle.seconds,
    period_label: formatPeriodLabel(cycle.seconds),
    quota_tokens: cycle.quota_tokens,
    quota_requests: cycle.quota_requests,
    used_tokens: cycle.used_tokens,
    used_requests: cycle.used_requests,
    remaining_tokens: cycle.quota_tokens !== null ? Math.max(0, cycle.quota_tokens - cycle.used_tokens) : null,
    remaining_requests: cycle.quota_requests !== null ? Math.max(0, cycle.quota_requests - cycle.used_requests) : null,
    reset_at: cycle.reset_at,
  };
}

// 逐档判定，返回首个被触发的档位（含周期名，便于定位是哪一档限制）。
// Token 档为「本次请求」预留预算（used + estimated > quota），Requests 档则按已用次数判定
// （本次请求尚未计入 used），与全局配额 checkQuota 的口径保持一致。
export function findExceededCycle(cycles: PeriodCycle[], estimatedTokens: number): { reason: string } | null {
  for (const cycle of cycles) {
    const label = formatPeriodLabel(cycle.seconds);
    if (cycle.quota_requests !== null && cycle.used_requests >= cycle.quota_requests) {
      return { reason: `周期请求配额已用尽（${label}）` };
    }
    if (cycle.quota_tokens !== null && cycle.used_tokens + estimatedTokens > cycle.quota_tokens) {
      return { reason: `周期 Token 配额已用尽（${label}）` };
    }
  }
  return null;
}

export async function checkQuota(userId: number, estimatedTokens: number): Promise<{ ok: false; reason: string; quota?: QuotaInfo } | { ok: true; quota: QuotaInfo }> {
  const user = await gatewayDb.queryOne<{
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
    period_cycles: string | null;
    rpm: number;
    qps: number;
    tpm: number;
  }>(
    `SELECT id, group_id, quota_tokens, quota_requests, used_tokens, used_requests,
              quota_period, period_quota_tokens, period_quota_requests,
              period_used_tokens, period_used_requests, period_reset_at, period_cycles,
              rpm, qps, tpm FROM users WHERE id = ? AND deleted_at IS NULL`,
    [userId],
  );

  if (!user) {
    return { ok: false, reason: "用户不存在" };
  }

  const limits = await getEffectiveLimits(user as DbUser);

  const quota: QuotaInfo = {
    remaining_requests: limits.quota_requests !== null ? Math.max(0, limits.quota_requests - user.used_requests) : null,
    remaining_tokens: limits.quota_tokens !== null ? Math.max(0, limits.quota_tokens - user.used_tokens) : null,
    periods: [],
  };

  if (limits.quota_requests !== null && user.used_requests >= limits.quota_requests) {
    return { ok: false, reason: "请求配额已用尽", quota };
  }

  if (limits.quota_tokens !== null && user.used_tokens + estimatedTokens > limits.quota_tokens) {
    return { ok: false, reason: "Token 配额已用尽", quota };
  }

  // 用户自有的周期档优先；用户没配任何档时用组档定义参与判定。
  // 组表没有运行时计数器，因此继承来的组档只作定义值：它的用量无法累积，
  // 也不能写进用户行（写进去就会被当成自有档位，组的后续调整对该用户永久失效）。
  const ownCycles = resolveStoredPeriodCycles(user.period_cycles, {
    quota_period: user.quota_period,
    period_quota_tokens: user.period_quota_tokens,
    period_quota_requests: user.period_quota_requests,
    period_used_tokens: user.period_used_tokens,
    period_used_requests: user.period_used_requests,
    period_reset_at: user.period_reset_at,
  });

  if (ownCycles.length > 0) {
    const reset = await ensureCycleResets("users", userId, ownCycles, undefined, user.period_cycles);
    quota.periods = reset.map(toPeriodQuotaEntry);
    const exceeded = findExceededCycle(reset, estimatedTokens);
    if (exceeded) {
      return { ok: false, reason: exceeded.reason, quota };
    }
  }

  return { ok: true, quota };
}

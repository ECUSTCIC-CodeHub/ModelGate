export const dynamic = "force-dynamic";

import { gatewayDb, type DbUser } from "@/lib/core/db";
import { getEffectiveLimits } from "@/lib/gateway/effective-limits";
import { ensureUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";

function formatPeriodLabel(seconds: number): string {
  if (seconds === 3600) return "每小时";
  if (seconds === 86400) return "每日";
  if (seconds === 604800) return "每周";
  if (seconds === 2592000) return "每月";
  if (seconds >= 86400) return `每 ${Math.round(seconds / 86400)} 天`;
  if (seconds >= 3600) return `每 ${Math.round(seconds / 3600)} 小时`;
  return `每 ${seconds} 秒`;
}

export async function GET(request: Request) {
  const guard = ensureUser(request);
  if ("error" in guard) return guard.error;

  const userId = guard.auth.user.id;
  const user = gatewayDb
    .prepare(`SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`)
    .get(userId) as DbUser | undefined;

  if (!user) {
    return jsonOk({ error: "用户不存在" }, 404);
  }

  const limits = getEffectiveLimits(user);

  const now = new Date();
  let periodUsedTokens = user.period_used_tokens;
  let periodUsedRequests = user.period_used_requests;
  const periodResetAt = user.period_reset_at;

  if (limits.quota_period && periodResetAt && new Date(periodResetAt) <= now) {
    periodUsedTokens = 0;
    periodUsedRequests = 0;
  }

  return jsonOk({
    total: {
      quota_requests: limits.quota_requests,
      quota_tokens: limits.quota_tokens,
      used_requests: user.used_requests,
      used_tokens: user.used_tokens,
      remaining_requests: limits.quota_requests !== null ? Math.max(0, limits.quota_requests - user.used_requests) : null,
      remaining_tokens: limits.quota_tokens !== null ? Math.max(0, limits.quota_tokens - user.used_tokens) : null,
    },
    period: limits.quota_period ? {
      period_seconds: limits.quota_period,
      period_label: formatPeriodLabel(limits.quota_period),
      quota_requests: limits.period_quota_requests,
      quota_tokens: limits.period_quota_tokens,
      used_requests: periodUsedRequests,
      used_tokens: periodUsedTokens,
      remaining_requests: limits.period_quota_requests !== null ? Math.max(0, limits.period_quota_requests - periodUsedRequests) : null,
      remaining_tokens: limits.period_quota_tokens !== null ? Math.max(0, limits.period_quota_tokens - periodUsedTokens) : null,
      reset_at: periodResetAt,
    } : null,
    rate: {
      rpm: limits.rpm,
      qps: limits.qps,
      tpm: limits.tpm,
    },
  });
}

export const dynamic = "force-dynamic";

import { gatewayDb, type DbUser } from "@/lib/core/db";
import { getEffectiveLimits } from "@/lib/gateway/effective-limits";
import { ensureUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";
import { parseStoredUtc } from "@/lib/core/db/datetime";
import { resolveStoredPeriodCycles } from "@/lib/gateway/period-cycles";
import { resolveEnforcedCycles } from "@/lib/gateway/effective-limits";
import { ensureCycleResets, loadGroupCycleState } from "@/lib/gateway/period-cycles-reset";
import { toPeriodQuotaEntry } from "@/lib/gateway/quota";
import { formatPeriodLabel } from "@/lib/shared/period-format";

export async function GET(request: Request) {
  const guard = await ensureUser(request);
  if ("error" in guard) return guard.error;

  const userId = guard.auth.user.id;
  const user = await gatewayDb
    .queryOne<DbUser>(`SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]);

  if (!user) {
    return jsonOk({ error: "用户不存在" }, 404);
  }

  const limits = await getEffectiveLimits(user);

  const now = new Date();
  let periodUsedTokens = user.period_used_tokens;
  let periodUsedRequests = user.period_used_requests;
  let periodResetAt: string | null = user.period_reset_at;

  const resetDate = parseStoredUtc(periodResetAt);
  if (limits.quota_period && resetDate && resetDate <= now) {
    periodUsedTokens = 0;
    periodUsedRequests = 0;
    const nextReset = new Date(now.getTime() + limits.quota_period * 1000);
    periodResetAt = nextReset.toISOString();
  }

  // 多档周期：先按档懒重置，再输出。
  // 自有档与继承自组的档位计数分开存放（period_cycles / group_period_cycles），
  // 因此这里分别推进窗口再合并展示，与判定、计费口径一致。
  const userCycles = resolveStoredPeriodCycles(user.period_cycles, user);
  const enforced = resolveEnforcedCycles(userCycles, limits.group_cycles);
  const ownState = enforced.own.length > 0
    ? await ensureCycleResets("users", userId, enforced.own, undefined, user.period_cycles)
    : [];
  const inheritedState = enforced.inherited.length > 0
    ? await loadGroupCycleState(userId, enforced.inherited)
    : [];
  const periods = [...ownState, ...inheritedState].map(toPeriodQuotaEntry);

  return jsonOk({
    total: {
      quota_requests: limits.quota_requests,
      quota_tokens: limits.quota_tokens,
      used_requests: user.used_requests,
      used_tokens: user.used_tokens,
      remaining_requests: limits.quota_requests !== null ? Math.max(0, limits.quota_requests - user.used_requests) : null,
      remaining_tokens: limits.quota_tokens !== null ? Math.max(0, limits.quota_tokens - user.used_tokens) : null,
    },
    periods,
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

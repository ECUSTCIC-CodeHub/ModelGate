export const dynamic = "force-dynamic";

import { gatewayDb, type DbUser } from "@/lib/core/db";
import { getEffectiveLimits } from "@/lib/gateway/effective-limits";
import { ensureUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";
import { ensureCycleResets, loadGroupCycleState } from "@/lib/gateway/period-cycles-reset";
import { toPeriodQuotaEntry } from "@/lib/gateway/quota";
import { parseInheritGroupPeriods } from "@/lib/gateway/period-cycles";

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

  // 多档周期：先按档懒重置，再输出。
  // 直接复用 getEffectiveLimits 算好的生效口径（已按总开关决定要不要让位给组档），
  // 自有档与继承档的计数分开存放，因此分别推进窗口再合并，与判定、计费口径一致。
  const enforced = limits.period_cycles;
  const ownState = enforced.own.length > 0
    ? await ensureCycleResets("users", userId, enforced.own, undefined, user.period_cycles)
    : [];
  const inheritedState = enforced.inherited.length > 0
    ? await loadGroupCycleState(userId, enforced.inherited)
    : [];
  const ownBySeconds = new Map(ownState.map((cycle) => [cycle.seconds, cycle]));
  const inheritedBySeconds = new Map(inheritedState.map((cycle) => [cycle.seconds, cycle]));
  const periods = enforced.all.map((cycle) => {
    const state = ownBySeconds.get(cycle.seconds) ?? inheritedBySeconds.get(cycle.seconds);
    return toPeriodQuotaEntry(state
      ? { ...cycle, used_tokens: state.used_tokens, used_requests: state.used_requests, reset_at: state.reset_at }
      : cycle);
  });

  return jsonOk({
    total: {
      quota_requests: limits.quota_requests,
      quota_tokens: limits.quota_tokens,
      used_requests: user.used_requests,
      used_tokens: user.used_tokens,
      // -1 是「显式不限制」，没有可用量；null 是未配置。
      remaining_requests: limits.quota_requests !== null && limits.quota_requests >= 0
        ? Math.max(0, limits.quota_requests - user.used_requests)
        : null,
      remaining_tokens: limits.quota_tokens !== null && limits.quota_tokens >= 0
        ? Math.max(0, limits.quota_tokens - user.used_tokens)
        : null,
    },
    periods,
    // 周期配额总开关的当前值。
    inherit_group_periods: parseInheritGroupPeriods(user.inherit_group_periods),
    rate: {
      rpm: limits.rpm,
      qps: limits.qps,
      tpm: limits.tpm,
    },
  });
}

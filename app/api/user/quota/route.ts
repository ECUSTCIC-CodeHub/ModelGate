export const dynamic = "force-dynamic";

import { gatewayDb, type DbUser } from "@/lib/core/db";
import { getEffectiveLimits } from "@/lib/gateway/effective-limits";
import { ensureUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";
import { resolveEffectivePeriods } from "@/lib/gateway/quota";
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

  // 多档周期与管理端、dashboard profile 共用同一份实现：它会把自有档与继承档
  // 分别推进窗口后按秒数合并两套计数，避免这里只取其中一边导致继承用量显示成 0。
  // 用户自查沿用「读时推进继承档窗口」的旧行为，窗口过期后不会继续展示上一窗口的用量。
  const periods = await resolveEffectivePeriods(userId, limits.period_cycles, user.period_cycles, {
    persistInherited: true,
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

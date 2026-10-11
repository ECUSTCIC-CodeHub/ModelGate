export const dynamic = "force-dynamic";

import { gatewayDb, type DbUser } from "@/lib/core/db";
import { getEffectiveLimits } from "@/lib/gateway/effective-limits";
import { ensureWebUser } from "@/lib/auth/guards";
import { sanitizeUser } from "@/lib/auth/auth";
import { jsonError, jsonOk } from "@/lib/core/http";
import { ensureCycleResets, loadGroupCycleState } from "@/lib/gateway/period-cycles-reset";
import { toPeriodQuotaEntry } from "@/lib/gateway/quota";

export async function GET(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  // 重新读取用户行，保证周期档计数是当前值，而不是令牌签发时的快照。
  // enabled / deleted_at 与鉴权路径同样的条件，避免这里成为绕过禁用状态的口子。
  const user = await gatewayDb.queryOne<DbUser>(
    `SELECT * FROM users WHERE id = ? AND enabled = 1 AND deleted_at IS NULL`,
    [guard.auth.user.id],
  );
  if (!user) return jsonError("用户不存在", 404);

  const effective = await getEffectiveLimits(user);

  // 多档周期与 /api/user/quota 同口径：先按档懒重置再输出。
  // 生效档位已由 getEffectiveLimits 算好（自有档 + 继承自组的档位），
  // 两者的计数分开存放，分别推进窗口后合并，与判定、计费口径一致。
  const enforced = effective.period_cycles;
  const ownState = enforced.own.length > 0
    ? await ensureCycleResets("users", user.id, enforced.own, undefined, user.period_cycles)
    : [];
  const inheritedState = enforced.inherited.length > 0
    ? await loadGroupCycleState(user.id, enforced.inherited)
    : [];
  const periods = [...ownState, ...inheritedState].map(toPeriodQuotaEntry);

  return jsonOk({
    user: {
      // 与 /api/auth/* 一致地脱敏，避免把 password_hash / totp_secret / token_version 回传给前端。
      ...sanitizeUser(user),
      rpm: effective.rpm,
      qps: effective.qps,
      tpm: effective.tpm,
      quota_tokens: effective.quota_tokens,
      quota_requests: effective.quota_requests,
      period_cycles: user.period_cycles ?? null,
      // 侧边栏按这里展示多档周期：组档已按每用户独立计数参与判定，
      // 因此必须把继承来的档位一并回传，否则用户看到的额度与实际生效的不一致。
      periods,
    },
  });
}

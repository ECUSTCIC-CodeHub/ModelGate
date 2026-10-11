export const dynamic = "force-dynamic";

import { type DbUser } from "@/lib/core/db";
import { getEffectiveLimits } from "@/lib/gateway/effective-limits";
import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";

export async function GET(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const user = guard.auth.user;
  const effective = await getEffectiveLimits(user as DbUser);

  return jsonOk({
    user: {
      ...user,
      rpm: effective.rpm,
      qps: effective.qps,
      tpm: effective.tpm,
      quota_tokens: effective.quota_tokens,
      quota_requests: effective.quota_requests,
      quota_period: effective.quota_period,
      period_quota_tokens: effective.period_quota_tokens,
      period_quota_requests: effective.period_quota_requests,
      // 只回用户自有的周期档：组级周期档当前只作定义、不参与判定，
      // 若在这里把合并结果当作用户配置返回，前端会看到一份实际不生效的额度。
      period_cycles: user.period_cycles ?? null,
    },
  });
}

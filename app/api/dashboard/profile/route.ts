export const dynamic = "force-dynamic";

import { type DbUser } from "@/lib/db";
import { getEffectiveLimits } from "@/lib/effective-limits";
import { ensureWebUser } from "@/lib/guards";
import { jsonOk } from "@/lib/http";

export async function GET(request: Request) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const user = guard.auth.user;
  const effective = getEffectiveLimits(user as DbUser);

  return jsonOk({
    user: {
      ...user,
      rpm: effective.rpm,
      qps: effective.qps,
      tpm: effective.tpm,
      quota_tokens: effective.quota_tokens,
      quota_requests: effective.quota_requests,
    },
  });
}

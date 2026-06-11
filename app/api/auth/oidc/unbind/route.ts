export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/core/db";
import { requireFeature } from "@/lib/core/features";
import { ensureWebUser } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";

export async function POST(request: Request) {
  const unavailable = requireFeature("oidc");
  if (unavailable) return unavailable;

  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const user = guard.auth.user;

  if (!user.oidc_issuer && !user.oidc_subject) {
    return jsonError("当前账号未绑定 OIDC", 400);
  }

  const defaultGroup = await gatewayDb
    .queryOne<{ id: number }>("SELECT id FROM `groups` WHERE is_default = 1 AND deleted_at IS NULL");

  await gatewayDb
    .execute("UPDATE users SET oidc_issuer = NULL, oidc_subject = NULL, group_id = ? WHERE id = ?", [defaultGroup?.id ?? null, user.id]);

  return jsonOk({ message: "OIDC 绑定已解除。" });
}

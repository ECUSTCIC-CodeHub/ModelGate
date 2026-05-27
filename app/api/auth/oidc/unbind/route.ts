export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/db";
import { featureUnavailableMessage, modelGateFeatures } from "@/lib/features";
import { ensureWebUser } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";

export async function POST(request: Request) {
  if (!modelGateFeatures.oidc) {
    return jsonError(featureUnavailableMessage("OIDC"), 404);
  }

  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const user = guard.auth.user;

  if (!user.oidc_issuer && !user.oidc_subject) {
    return jsonError("当前账号未绑定 OIDC", 400);
  }

  const defaultGroup = gatewayDb
    .prepare("SELECT id FROM groups WHERE is_default = 1 AND deleted_at IS NULL")
    .get() as { id: number } | undefined;

  gatewayDb
    .prepare("UPDATE users SET oidc_issuer = NULL, oidc_subject = NULL, group_id = ? WHERE id = ?")
    .run(defaultGroup?.id ?? null, user.id);

  return jsonOk({ message: "OIDC 绑定已解除。" });
}

export const dynamic = "force-dynamic";

import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";
import { listAccessibleModels } from "@/lib/gateway/model-access";

export async function GET(request: Request) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const models = listAccessibleModels(guard.auth.user);
  return jsonOk({
    object: "list",
    data: models.map((m) => ({
      id: m.alias,
      object: "model",
      token_multiplier: m.token_multiplier,
      request_multiplier: m.request_multiplier,
    })),
  });
}

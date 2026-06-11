export const dynamic = "force-dynamic";

import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";
import { listAccessibleModels } from "@/lib/gateway/model-access";

export async function GET(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const models = await listAccessibleModels(guard.auth.user);
  return jsonOk({
    object: "list",
    data: models.map((m) => ({
      id: m.alias,
      object: "model",
      token_multiplier: m.token_multiplier,
      request_multiplier: m.request_multiplier,
      token_multiplier_min: m.token_multiplier_min,
      token_multiplier_max: m.token_multiplier_max,
      request_multiplier_min: m.request_multiplier_min,
      request_multiplier_max: m.request_multiplier_max,
      channels: m.channels,
    })),
  });
}

export const dynamic = "force-dynamic";

import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";
import { listAccessibleModels } from "@/lib/gateway/model-access";
import { getGatewaySettings, parseModelBrandGroups } from "@/lib/core/settings";

export async function GET(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const [models, settings] = await Promise.all([
    listAccessibleModels(guard.auth.user),
    getGatewaySettings(),
  ]);
  return jsonOk({
    object: "list",
    brand_groups: parseModelBrandGroups(settings.model_brand_groups),
    data: models.map((m) => ({
      id: m.alias,
      object: "model",
      supports_vision: m.supports_vision === 1,
      supported_protocols: m.supported_protocols,
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

export const dynamic = "force-dynamic";

import { ensureWebUser } from "@/lib/auth/guards";
import { featureUnavailableMessage, modelGateFeatures } from "@/lib/core/features";
import { jsonError, jsonOk } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";

export async function GET(request: Request) {
  if (!modelGateFeatures.announcement) {
    return jsonError(featureUnavailableMessage("公告"), 404);
  }

  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const row = gatewayDb
    .prepare("SELECT value FROM settings WHERE key = 'announcement_content'")
    .get() as { value: string } | undefined;

  return jsonOk({ content: row?.value ?? "" });
}

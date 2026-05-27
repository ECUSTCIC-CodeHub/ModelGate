export const dynamic = "force-dynamic";

import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";
import { listAccessibleModelAliases } from "@/lib/gateway/model-access";

export async function GET(request: Request) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const aliases = listAccessibleModelAliases(guard.auth.user);
  return jsonOk({
    object: "list",
    data: aliases.map((alias) => ({
      id: alias,
      object: "model",
    })),
  });
}

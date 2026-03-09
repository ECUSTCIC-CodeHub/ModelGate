export const dynamic = "force-dynamic";

import { ensureWebUser } from "@/lib/guards";
import { jsonOk } from "@/lib/http";
import { listEnabledAliases } from "@/lib/router";

export async function GET(request: Request) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const aliases = listEnabledAliases();
  return jsonOk({
    object: "list",
    data: aliases.map((item) => ({
      id: item.alias,
      object: "model",
    })),
  });
}

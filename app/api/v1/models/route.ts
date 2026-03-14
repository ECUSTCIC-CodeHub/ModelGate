export const dynamic = "force-dynamic";

import { checkApiKeyAuth } from "@/lib/api-key-auth";
import { jsonError, jsonOk } from "@/lib/http";
import { listAccessibleModelAliases } from "@/lib/model-access";

export async function GET(request: Request) {
  const auth = checkApiKeyAuth(request);
  if (!auth.ok) {
    return jsonError(auth.reason === "missing" ? "认证失败，未提供 API Key。" : "认证失败，API Key 无效或已禁用。", 401, {
      type: "auth_error",
      param: "None",
      code: "401",
    });
  }

  const aliases = listAccessibleModelAliases(auth.context.user);
  return jsonOk({
    object: "list",
    data: aliases.map((alias) => ({ id: alias, object: "model" })),
  });
}

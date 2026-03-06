import { requireApiKey } from "@/lib/api-key-auth";
import { jsonError, jsonOk } from "@/lib/http";
import { listEnabledAliases } from "@/lib/router";

export async function GET(request: Request) {
  const auth = requireApiKey(request);
  if (!auth) {
    return jsonError("认证失败，未提供 API Key。", 401, {
      type: "auth_error",
      param: "None",
      code: "401",
    });
  }

  const aliases = listEnabledAliases();
  return jsonOk({
    object: "list",
    data: aliases.map((a) => ({ id: a.alias, object: "model" })),
  });
}

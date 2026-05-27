import { gatewayDb, type DbKey, type DbUser } from "@/lib/db";
import { parseBearerToken } from "@/lib/http";
import { AUTH_DISABLED, getNoAuthContext } from "@/lib/no-auth";

export type ApiKeyContext = {
  key: DbKey;
  user: DbUser;
};

export type ApiKeyAuthResult =
  | { ok: true; context: ApiKeyContext }
  | { ok: false; reason: "missing" | "invalid" };

const keyByValueStmt = gatewayDb.prepare("SELECT * FROM keys WHERE key = ? AND enabled = 1 AND deleted_at IS NULL");
const userByIdStmt = gatewayDb.prepare("SELECT * FROM users WHERE id = ? AND enabled = 1 AND deleted_at IS NULL");

export function checkApiKeyAuth(request: Request): ApiKeyAuthResult {
  if (AUTH_DISABLED) {
    return { ok: true, context: getNoAuthContext() };
  }

  const raw = request.headers.get("x-api-key") ?? parseBearerToken(request.headers.get("authorization"));
  if (!raw) return { ok: false, reason: "missing" };

  const key = keyByValueStmt.get(raw) as DbKey | undefined;

  if (!key) return { ok: false, reason: "invalid" };

  const user = userByIdStmt.get(key.user_id) as DbUser | undefined;

  if (!user) return { ok: false, reason: "invalid" };
  return { ok: true, context: { key, user } };
}

export function requireApiKey(request: Request): ApiKeyContext | null {
  const result = checkApiKeyAuth(request);
  if (!result.ok) return null;
  return result.context;
}

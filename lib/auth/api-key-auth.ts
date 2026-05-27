import { gatewayDb, type DbKey, type DbUser } from "@/lib/core/db";
import { parseBearerToken } from "@/lib/core/http";
import { AUTH_DISABLED, getNoAuthContext } from "@/lib/auth/no-auth";

export type ApiKeyContext = {
  key: DbKey;
  user: DbUser;
};

export type ApiKeyAuthResult =
  | { ok: true; context: ApiKeyContext }
  | { ok: false; reason: "missing" | "invalid" };

const keyByValueStmt = gatewayDb.prepare("SELECT * FROM keys WHERE key = ? AND enabled = 1 AND deleted_at IS NULL");
const userByIdStmt = gatewayDb.prepare("SELECT * FROM users WHERE id = ? AND enabled = 1 AND deleted_at IS NULL");

function normalizeApiKey(value: string | null) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function parseQueryApiKey(url: string) {
  const params = new URL(url, "http://localhost").searchParams;
  return normalizeApiKey(params.get("token")) ?? normalizeApiKey(params.get("api_key"));
}

export function checkApiKeyAuth(request: Request): ApiKeyAuthResult {
  if (AUTH_DISABLED) {
    return { ok: true, context: getNoAuthContext() };
  }

  const raw =
    normalizeApiKey(request.headers.get("x-api-key"))
    ?? normalizeApiKey(parseBearerToken(request.headers.get("authorization")))
    ?? parseQueryApiKey(request.url);
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

import { gatewayDb, type DbKey, type DbUser } from "@/lib/db";
import { parseBearerToken } from "@/lib/http";

export type ApiKeyContext = {
  key: DbKey;
  user: DbUser;
};

export function requireApiKey(request: Request): ApiKeyContext | null {
  const raw = parseBearerToken(request.headers.get("authorization"));
  if (!raw) return null;

  const key = gatewayDb
    .prepare("SELECT * FROM keys WHERE key = ? AND enabled = 1")
    .get(raw) as DbKey | undefined;

  if (!key) return null;

  const user = gatewayDb
    .prepare("SELECT * FROM users WHERE id = ? AND enabled = 1")
    .get(key.user_id) as DbUser | undefined;

  if (!user) return null;
  return { key, user };
}

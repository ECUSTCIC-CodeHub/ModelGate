import { type AuthContext, requireRole, requireWebAuth, sanitizeUser } from "@/lib/auth/auth";
import { checkApiKeyAuth } from "@/lib/auth/api-key-auth";
import { jsonError } from "@/lib/core/http";

async function resolveAuth(request: Request): Promise<AuthContext | null> {
  const webAuth = await requireWebAuth(request);
  if (webAuth) return webAuth;

  const apiKeyResult = await checkApiKeyAuth(request);
  if (apiKeyResult.ok) {
    return {
      user: sanitizeUser(apiKeyResult.context.user),
      token: apiKeyResult.context.key.key,
    };
  }

  return null;
}

export async function ensureAdmin(request: Request) {
  const auth = await resolveAuth(request);
  if (!auth) {
    return { error: jsonError("未登录或登录已过期", 401) };
  }
  if (!requireRole(auth, "admin")) {
    return { error: jsonError("无权限访问", 403) };
  }
  return { auth };
}

export async function ensureWebUser(request: Request) {
  const auth = await resolveAuth(request);
  if (!auth) {
    return { error: jsonError("未登录或登录已过期", 401) };
  }
  return { auth };
}

export async function ensureUser(request: Request) {
  const auth = await resolveAuth(request);
  if (!auth) {
    return { error: jsonError("未登录或登录已过期", 401) };
  }
  return { auth };
}

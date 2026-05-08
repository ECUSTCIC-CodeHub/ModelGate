import { type AuthContext, requireRole, requireWebAuth, sanitizeUser } from "@/lib/auth";
import { checkApiKeyAuth } from "@/lib/api-key-auth";
import { jsonError } from "@/lib/http";

function resolveAuth(request: Request): AuthContext | null {
  const webAuth = requireWebAuth(request);
  if (webAuth) return webAuth;

  const apiKeyResult = checkApiKeyAuth(request);
  if (apiKeyResult.ok) {
    return {
      user: sanitizeUser(apiKeyResult.context.user),
      token: apiKeyResult.context.key.key,
    };
  }

  return null;
}

export function ensureAdmin(request: Request) {
  const auth = resolveAuth(request);
  if (!auth) {
    return { error: jsonError("未登录或登录已过期", 401) };
  }
  if (!requireRole(auth, "admin")) {
    return { error: jsonError("无权限访问", 403) };
  }
  return { auth };
}

export function ensureWebUser(request: Request) {
  const auth = resolveAuth(request);
  if (!auth) {
    return { error: jsonError("未登录或登录已过期", 401) };
  }
  return { auth };
}

export function ensureUser(request: Request) {
  const auth = resolveAuth(request);
  if (!auth) {
    return { error: jsonError("未登录或登录已过期", 401) };
  }
  return { auth };
}

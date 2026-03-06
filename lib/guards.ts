import { requireRole, requireWebAuth } from "@/lib/auth";
import { jsonError } from "@/lib/http";

export function ensureAdmin(request: Request) {
  const auth = requireWebAuth(request);
  if (!auth) {
    return { error: jsonError("未登录或登录已过期", 401) };
  }
  if (!requireRole(auth, "admin")) {
    return { error: jsonError("无权限访问", 403) };
  }
  return { auth };
}

export function ensureWebUser(request: Request) {
  const auth = requireWebAuth(request);
  if (!auth) {
    return { error: jsonError("未登录或登录已过期", 401) };
  }
  return { auth };
}

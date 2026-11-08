import { type AuthContext, requireRole, requireWebAuth, requireWebAuthWithRefresh, sanitizeUser } from "@/lib/auth/auth";
import { checkApiKeyAuth } from "@/lib/auth/api-key-auth";
import { dbCapacityResponse, jsonError } from "@/lib/core/http";

// 鉴权过程中可能撞上数据库容量错误（连接池排队满 / 等待连接超时）。
// 这类错误必须转成 503，不能退化为 401：否则池一饱和，所有已登录用户都被判定为「未登录」，
// 前端集中跳转登录页重登，把登录接口和连接池一起压垮。
async function resolveAuth(
  request: Request,
  { allowRefresh = false }: { allowRefresh?: boolean } = {},
): Promise<{ auth: AuthContext | null } | { capacity: Response }> {
  try {
    const webAuth = allowRefresh ? await requireWebAuthWithRefresh(request) : await requireWebAuth(request);
    if (webAuth) return { auth: webAuth };

    const apiKeyResult = await checkApiKeyAuth(request);
    if (apiKeyResult.ok) {
      return {
        auth: {
          user: sanitizeUser(apiKeyResult.context.user),
          token: apiKeyResult.context.key.key,
          authSource: "apikey",
        },
      };
    }

    return { auth: null };
  } catch (err) {
    const capacity = dbCapacityResponse(err);
    if (capacity) return { capacity };
    throw err;
  }
}

export async function ensureAdmin(request: Request) {
  const resolved = await resolveAuth(request);
  if ("capacity" in resolved) return { error: resolved.capacity };
  const auth = resolved.auth;
  if (!auth) {
    return { error: jsonError("未登录或登录已过期", 401) };
  }
  if (!requireRole(auth, "admin")) {
    return { error: jsonError("无权限访问", 403) };
  }
  return { auth };
}

export async function ensureAdminWeb(request: Request) {
  const resolved = await resolveAuth(request);
  if ("capacity" in resolved) return { error: resolved.capacity };
  const auth = resolved.auth;
  if (!auth) {
    return { error: jsonError("未登录或登录已过期", 401) };
  }
  if (auth.authSource === "apikey") {
    return { error: jsonError("请使用管理员账号登录后操作", 403) };
  }
  if (!requireRole(auth, "admin")) {
    return { error: jsonError("无权限访问", 403) };
  }
  return { auth };
}

export async function ensureWebUser(request: Request) {
  const resolved = await resolveAuth(request);
  if ("capacity" in resolved) return { error: resolved.capacity };
  const auth = resolved.auth;
  if (!auth) {
    return { error: jsonError("未登录或登录已过期", 401) };
  }
  return { auth };
}

export async function ensureUser(request: Request) {
  const resolved = await resolveAuth(request);
  if ("capacity" in resolved) return { error: resolved.capacity };
  const auth = resolved.auth;
  if (!auth) {
    return { error: jsonError("未登录或登录已过期", 401) };
  }
  return { auth };
}

// 仅供整页表单提交使用：这类请求没有 authedFetch 那层「401 先刷新再重试」，
// access 过期而 refresh 仍有效时再判 401 会把用户直接丢到一段 JSON 上，
// 这里按页面渲染的口径放行。普通接口继续用 ensureUser，不要换成这个。
export async function ensureUserWithRefresh(request: Request): Promise<{ auth: AuthContext } | { error: Response }> {
  const resolved = await resolveAuth(request, { allowRefresh: true });
  if ("capacity" in resolved) return { error: resolved.capacity };
  const auth = resolved.auth;
  if (!auth) {
    return { error: jsonError("未登录或登录已过期", 401) };
  }
  return { auth };
}

import { type AuthContext, requireRole, requireWebAuth, requireWebAuthWithRefresh, sanitizeUser } from "@/lib/auth/auth";
import { checkApiKeyAuth } from "@/lib/auth/api-key-auth";
import { dbCapacityResponse, jsonError } from "@/lib/core/http";

const API_KEY_FORBIDDEN_MESSAGE = "该接口涉及账号凭据，请使用网页登录后操作";

// 账号 / 凭据管理类接口的准入：只认 Web 会话，拒绝 API Key。
// API Key 是模型调用令牌，不应具备账号级能力，否则任何一枚 key 泄漏都等于账号失守。
export function apiKeyForbiddenResponse() {
  return jsonError(API_KEY_FORBIDDEN_MESSAGE, 403);
}

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

// 管理端通用准入，API Key 也放行：管理端数据读取（渠道、模型、用户、日志）原本就接受
// 管理员密钥，收掉会打断既有脚本查询，收益也小。凭据读取（明文渠道密钥）与发信走 ensureAdminWeb。
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

// 派发敏感动作（发信）与读取管理端凭据时必须走这里，调用点由 verify-auth-scope 守住。
export async function ensureAdminWeb(request: Request) {
  const resolved = await resolveAuth(request);
  if ("capacity" in resolved) return { error: resolved.capacity };
  const auth = resolved.auth;
  if (!auth) {
    return { error: jsonError("未登录或登录已过期", 401) };
  }
  if (auth.authSource === "apikey") {
    return { error: apiKeyForbiddenResponse() };
  }
  if (!requireRole(auth, "admin")) {
    return { error: jsonError("无权限访问", 403) };
  }
  return { auth };
}

// 用户账号凭据的读写（密钥管理、兑换码、DSH 授权）必须走这里：这些接口一旦认 API Key，
// 持有任意一枚 key 就等于拿到整个账号。
export async function ensureWebUser(request: Request) {
  const resolved = await resolveAuth(request);
  if ("capacity" in resolved) return { error: resolved.capacity };
  const auth = resolved.auth;
  if (!auth) {
    return { error: jsonError("未登录或登录已过期", 401) };
  }
  if (auth.authSource === "apikey") {
    return { error: apiKeyForbiddenResponse() };
  }
  return { auth };
}

// 保留 API Key 通道：仅用于只读、不含凭据的接口（如配额、用量日志、模型额度、可见模型列表）。
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
// 这里按页面渲染的口径放行。普通接口继续用 ensureWebUser，不要换成这个。
export async function ensureUserWithRefresh(request: Request): Promise<{ auth: AuthContext } | { error: Response }> {
  const resolved = await resolveAuth(request, { allowRefresh: true });
  if ("capacity" in resolved) return { error: resolved.capacity };
  const auth = resolved.auth;
  if (!auth) {
    return { error: jsonError("未登录或登录已过期", 401) };
  }
  if (auth.authSource === "apikey") {
    return { error: apiKeyForbiddenResponse() };
  }
  return { auth };
}

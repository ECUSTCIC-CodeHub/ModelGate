export const dynamic = "force-dynamic";

import { z } from "zod";
import { applyAuthCookies, clearAuthCookies, getRefreshTokenFromRequest, issueAuthTokens, verifyRefreshToken } from "@/lib/auth/auth";
import { gatewayDb, type DbUser } from "@/lib/core/db";
import { jsonError, jsonOk } from "@/lib/core/http";

const schema = z.object({
  refresh_token: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) return clearAuthCookies(jsonError("请求参数不正确", 400));
  const refreshToken = getRefreshTokenFromRequest(request) ?? parsed.data.refresh_token;
  if (!refreshToken) return clearAuthCookies(jsonError("登录已过期，请重新登录", 401));

  try {
    const payload = verifyRefreshToken(refreshToken);
    if (payload.type !== "refresh") return clearAuthCookies(jsonError("刷新令牌无效", 401));

    const user = await gatewayDb
      .queryOne<DbUser>("SELECT * FROM users WHERE id = ? AND enabled = 1 AND deleted_at IS NULL", [Number(payload.sub)]);

    if (!user) return clearAuthCookies(jsonError("刷新令牌无效", 401));

    const responsePayload = { ...issueAuthTokens(user), message: "令牌刷新成功。" };
    return applyAuthCookies(jsonOk(responsePayload), responsePayload);
  } catch {
    return clearAuthCookies(jsonError("刷新令牌无效", 401));
  }
}

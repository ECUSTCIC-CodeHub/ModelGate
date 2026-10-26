export const dynamic = "force-dynamic";

import { z } from "zod";
import {
  applyAuthCookies,
  clearAuthCookies,
  getRefreshTokenFromRequest,
  issueAuthTokens,
  resolveRefreshTokenUser,
} from "@/lib/auth/auth";
import { dbCapacityResponse, jsonError, jsonOk } from "@/lib/core/http";
import { readJsonBodyCapped } from "@/lib/core/request-body";

const schema = z.object({
  refresh_token: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  const body = await readJsonBodyCapped(request);
  if (!body.ok) return clearAuthCookies(jsonError("请求体过大", 413));
  const parsed = schema.safeParse(body.data ?? {});
  if (!parsed.success) return clearAuthCookies(jsonError("请求参数不正确", 400));
  const refreshToken = getRefreshTokenFromRequest(request) ?? parsed.data.refresh_token;
  if (!refreshToken) return clearAuthCookies(jsonError("登录已过期，请重新登录", 401));

  let user: Awaited<ReturnType<typeof resolveRefreshTokenUser>>;
  try {
    user = await resolveRefreshTokenUser(refreshToken);
  } catch (err) {
    // 服务端繁忙时不清 cookie：清掉只会把用户踢回登录页，与容量问题无关
    const busy = dbCapacityResponse(err);
    if (busy) return busy;
    throw err;
  }
  if (!user) return clearAuthCookies(jsonError("刷新令牌无效", 401));

  const responsePayload = { ...issueAuthTokens(user), message: "令牌刷新成功。" };
  return applyAuthCookies(jsonOk(responsePayload), responsePayload);
}

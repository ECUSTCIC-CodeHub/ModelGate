export const dynamic = "force-dynamic";

import { z } from "zod";
import { applyAuthCookies, getRefreshTokenFromRequest, issueAuthTokens, verifyRefreshToken } from "@/lib/auth";
import { gatewayDb, type DbUser } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/http";

const schema = z.object({
  refresh_token: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) return jsonError("请求参数不正确", 400);
  const refreshToken = parsed.data.refresh_token ?? getRefreshTokenFromRequest(request);
  if (!refreshToken) return jsonError("请求参数不正确", 400);

  try {
    const payload = verifyRefreshToken(refreshToken);
    if (payload.type !== "refresh") return jsonError("刷新令牌无效", 401);

    const user = gatewayDb
      .prepare("SELECT * FROM users WHERE id = ? AND enabled = 1 AND deleted_at IS NULL")
      .get(Number(payload.sub)) as DbUser | undefined;

    if (!user) return jsonError("刷新令牌无效", 401);

    const responsePayload = { ...issueAuthTokens(user), message: "令牌刷新成功。" };
    return applyAuthCookies(jsonOk(responsePayload), responsePayload);
  } catch {
    return jsonError("刷新令牌无效", 401);
  }
}

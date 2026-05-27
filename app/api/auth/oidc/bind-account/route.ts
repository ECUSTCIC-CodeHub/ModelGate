export const dynamic = "force-dynamic";

import { z } from "zod";
import { NextResponse } from "next/server";
import {
  applyAuthCookies,
  comparePassword,
  hashPassword,
  issueAuthTokens,
  sanitizeUser,
  verifyOidcPendingToken,
  OIDC_PENDING_COOKIE_NAME,
} from "@/lib/auth/auth";
import { gatewayDb, type DbUser } from "@/lib/core/db";
import { requireFeature } from "@/lib/core/features";
import { jsonError, jsonOk } from "@/lib/core/http";
import { checkLoginRateLimit } from "@/lib/auth/login-ratelimit";
import { deriveUsername, resolveGroupFromClaims } from "@/lib/auth/oidc";
import { USERNAME_SCHEMA } from "@/lib/auth/username";
import { randomBytes } from "node:crypto";

const linkSchema = z.object({
  mode: z.literal("link"),
  username: z.string().min(1),
  password: z.string().min(1),
});

const createSchema = z.object({
  mode: z.literal("create"),
  username: USERNAME_SCHEMA.optional(),
});

function parseCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return null;
  const pair = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  if (!pair) return null;
  return decodeURIComponent(pair.slice(name.length + 1));
}

function clearPendingCookie(res: NextResponse) {
  res.cookies.set(OIDC_PENDING_COOKIE_NAME, "", { httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: 0 });
  return res;
}

export async function POST(request: Request) {
  const unavailable = requireFeature("oidc");
  if (unavailable) return unavailable;

  const pendingToken = parseCookie(request.headers.get("cookie"), OIDC_PENDING_COOKIE_NAME);
  if (!pendingToken) return jsonError("绑定信息已过期，请重新登录", 401);

  const pending = verifyOidcPendingToken(pendingToken);
  if (!pending) return jsonError("绑定信息已过期，请重新登录", 401);

  const body = await request.json().catch(() => null);
  const linkParsed = linkSchema.safeParse(body);
  const createParsed = createSchema.safeParse(body);

  if (linkParsed.success) {
    const rateCheck = checkLoginRateLimit(request);
    if (!rateCheck.ok) return jsonError("尝试过于频繁，请稍后再试", 429);

    const user = gatewayDb
      .prepare("SELECT * FROM users WHERE username = ? AND deleted_at IS NULL")
      .get(linkParsed.data.username) as DbUser | undefined;

    if (!user || user.enabled !== 1) return jsonError("用户名或密码错误", 401);

    const ok = await comparePassword(linkParsed.data.password, user.password_hash);
    if (!ok) return jsonError("用户名或密码错误", 401);

    gatewayDb
      .prepare("UPDATE users SET oidc_issuer = NULL, oidc_subject = NULL WHERE oidc_issuer = ? AND oidc_subject = ? AND id != ?")
      .run(pending.issuer, pending.sub, user.id);

    const claimGroupId = resolveGroupFromClaims(pending.rawClaims);
    if (claimGroupId !== null) {
      gatewayDb
        .prepare("UPDATE users SET oidc_issuer = ?, oidc_subject = ?, group_id = ? WHERE id = ?")
        .run(pending.issuer, pending.sub, claimGroupId, user.id);
    } else {
      gatewayDb
        .prepare("UPDATE users SET oidc_issuer = ?, oidc_subject = ? WHERE id = ?")
        .run(pending.issuer, pending.sub, user.id);
    }

    const tokens = issueAuthTokens(user);
    const payload = { message: "绑定成功。", user: sanitizeUser(user), ...tokens };
    const res = applyAuthCookies(jsonOk(payload), payload);
    return clearPendingCookie(res);
  }

  if (createParsed.success) {
    gatewayDb
      .prepare("UPDATE users SET oidc_issuer = NULL, oidc_subject = NULL WHERE oidc_issuer = ? AND oidc_subject = ?")
      .run(pending.issuer, pending.sub);

    const adminCount = gatewayDb
      .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND deleted_at IS NULL")
      .get() as { count: number };
    const role: "admin" | "user" = adminCount.count === 0 ? "admin" : "user";

    const claimGroupId = resolveGroupFromClaims(pending.rawClaims);
    const defaultGroup = gatewayDb
      .prepare("SELECT id FROM groups WHERE is_default = 1 AND deleted_at IS NULL")
      .get() as { id: number } | undefined;
    const groupId = claimGroupId ?? defaultGroup?.id ?? null;

    let username = createParsed.data.username
      || deriveUsername({ sub: pending.sub, name: pending.name, preferred_username: pending.preferred_username, email: pending.email });

    const existing = gatewayDb
      .prepare("SELECT id FROM users WHERE username = ?")
      .get(username) as { id: number } | undefined;
    if (existing) {
      if (createParsed.data.username) return jsonError("用户名已存在", 409);
      username = username + randomBytes(3).toString("hex");
    }

    const placeholderHash = await hashPassword(randomBytes(32).toString("hex"));

    gatewayDb
      .prepare(
        `INSERT INTO users (username, password_hash, role, group_id, oidc_issuer, oidc_subject,
           rpm, qps, tpm, quota_tokens, quota_requests, enabled)
         VALUES (?, ?, ?, ?, ?, ?, -1, -1, -1, NULL, NULL, 1)`,
      )
      .run(username, placeholderHash, role, groupId, pending.issuer, pending.sub);

    const user = gatewayDb
      .prepare("SELECT * FROM users WHERE oidc_issuer = ? AND oidc_subject = ? AND deleted_at IS NULL")
      .get(pending.issuer, pending.sub) as DbUser | undefined;

    if (!user) return jsonError("创建账号失败", 500);

    const tokens = issueAuthTokens(user);
    const payload = { message: "账号创建成功。", user: sanitizeUser(user), ...tokens };
    const res = applyAuthCookies(jsonOk(payload, 201), payload);
    return clearPendingCookie(res);
  }

  return jsonError("请求参数不正确", 400);
}

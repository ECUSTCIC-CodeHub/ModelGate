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
  signTotpPendingToken,
} from "@/lib/auth/auth";
import { gatewayDb, type DbUser } from "@/lib/core/db";
import { requireFeature } from "@/lib/core/features";
import { jsonError, jsonOk } from "@/lib/core/http";
import { checkLoginRateLimit } from "@/lib/auth/login-ratelimit";
import { deriveUsername, resolveGroupFromClaims, getOidcConfig } from "@/lib/auth/oidc";
import { USERNAME_SCHEMA } from "@/lib/auth/username";
import { randomBytes } from "node:crypto";
import { getGatewaySettings } from "@/lib/core/settings";

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
    const settings = await getGatewaySettings();
    if (settings.password_login_enabled !== 1) {
      return jsonError("账号密码登录已关闭，无法通过密码绑定 OIDC", 403);
    }

    const rateCheck = checkLoginRateLimit(request, linkParsed.data.username);
    if (!rateCheck.ok) return jsonError("尝试过于频繁，请稍后再试", 429);

    const user = await gatewayDb
      .queryOne<DbUser>("SELECT * FROM users WHERE username = ? AND deleted_at IS NULL", [linkParsed.data.username]);

    if (!user || user.enabled !== 1) return jsonError("用户名或密码错误", 401);

    const ok = await comparePassword(linkParsed.data.password, user.password_hash);
    if (!ok) return jsonError("用户名或密码错误", 401);

    await gatewayDb
      .execute("UPDATE users SET oidc_issuer = NULL, oidc_subject = NULL WHERE oidc_issuer = ? AND oidc_subject = ? AND id != ?", [pending.issuer, pending.sub, user.id]);

    const linkEmail = pending.email?.toLowerCase() ?? null;
    const claimGroupId = await resolveGroupFromClaims(pending.rawClaims);
    if (claimGroupId !== null) {
      await gatewayDb
        .execute("UPDATE users SET oidc_issuer = ?, oidc_subject = ?, email = COALESCE(?, email), group_id = ? WHERE id = ?", [pending.issuer, pending.sub, linkEmail, claimGroupId, user.id]);
    } else {
      await gatewayDb
        .execute("UPDATE users SET oidc_issuer = ?, oidc_subject = ?, email = COALESCE(?, email) WHERE id = ?", [pending.issuer, pending.sub, linkEmail, user.id]);
    }

    if (user.totp_enabled === 1 && user.totp_secret) {
      const pendingToken = signTotpPendingToken(user);
      return clearPendingCookie(jsonOk({
        totp_required: true,
        pending_token: pendingToken,
        message: "绑定成功，请完成 TOTP 二次验证。",
      }));
    }

    const tokens = issueAuthTokens(user);
    const payload = { message: "绑定成功。", user: sanitizeUser(user), ...tokens };
    const res = applyAuthCookies(jsonOk(payload), payload);
    return clearPendingCookie(res);
  }

  if (createParsed.success) {
    const config = await getOidcConfig();
    if (!config.autoRegister) {
      const adminCount = (await gatewayDb
        .queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND deleted_at IS NULL"))!;
      if (adminCount.count > 0) {
        return jsonError("自动注册已关闭，请联系管理员创建账号", 403);
      }
    }

    await gatewayDb
      .execute("UPDATE users SET oidc_issuer = NULL, oidc_subject = NULL WHERE oidc_issuer = ? AND oidc_subject = ?", [pending.issuer, pending.sub]);

    const createEmail = pending.email?.toLowerCase() ?? null;

    if (createEmail) {
      const emailUser = await gatewayDb
        .queryOne<DbUser>("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL", [createEmail]);
      if (emailUser) {
        await gatewayDb
          .execute("UPDATE users SET oidc_issuer = NULL, oidc_subject = NULL WHERE oidc_issuer = ? AND oidc_subject = ? AND id != ?", [pending.issuer, pending.sub, emailUser.id]);
        await gatewayDb
          .execute("UPDATE users SET oidc_issuer = ?, oidc_subject = ? WHERE id = ?", [pending.issuer, pending.sub, emailUser.id]);

        const user = await gatewayDb
          .queryOne<DbUser>("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL", [emailUser.id]);
        if (!user) return jsonError("账号绑定失败", 500);

        const tokens = issueAuthTokens(user);
        const payload = { message: "绑定成功。", user: sanitizeUser(user), ...tokens };
        const res = applyAuthCookies(jsonOk(payload), payload);
        return clearPendingCookie(res);
      }
    }

    const adminCount = (await gatewayDb
      .queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND deleted_at IS NULL"))!;
    const role: "admin" | "user" = adminCount.count === 0 ? "admin" : "user";

    const claimGroupId = await resolveGroupFromClaims(pending.rawClaims);
    const defaultGroup = await gatewayDb
      .queryOne<{ id: number }>("SELECT id FROM `groups` WHERE is_default = 1 AND deleted_at IS NULL");
    const groupId = claimGroupId ?? defaultGroup?.id ?? null;

    let username = createParsed.data.username
      || deriveUsername({ sub: pending.sub, name: pending.name, preferred_username: pending.preferred_username, email: pending.email });

    const existing = await gatewayDb
      .queryOne<{ id: number }>("SELECT id FROM users WHERE username = ?", [username]);
    if (existing) {
      if (createParsed.data.username) return jsonError("用户名已存在", 409);
      username = username + randomBytes(3).toString("hex");
    }

    const placeholderHash = await hashPassword(randomBytes(32).toString("hex"));

    await gatewayDb
      .execute(
        `INSERT INTO users (username, password_hash, role, group_id, oidc_issuer, oidc_subject, email,
           rpm, qps, tpm, quota_tokens, quota_requests, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, -1, -1, -1, NULL, NULL, 1)`,
        [username, placeholderHash, role, groupId, pending.issuer, pending.sub, createEmail],
      );

    const user = await gatewayDb
      .queryOne<DbUser>("SELECT * FROM users WHERE oidc_issuer = ? AND oidc_subject = ? AND deleted_at IS NULL", [pending.issuer, pending.sub]);

    if (!user) return jsonError("创建账号失败", 500);

    const tokens = issueAuthTokens(user);
    const payload = { message: "账号创建成功。", user: sanitizeUser(user), ...tokens };
    const res = applyAuthCookies(jsonOk(payload, 201), payload);
    return clearPendingCookie(res);
  }

  return jsonError("请求参数不正确", 400);
}

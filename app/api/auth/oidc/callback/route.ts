export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { applyAuthCookies, hashPassword, issueAuthTokens, requireWebAuthWithRefresh, sanitizeUser } from "@/lib/auth";
import { gatewayDb, type DbUser } from "@/lib/db";
import {
  getOidcConfig,
  fetchDiscovery,
  exchangeCode,
  extractIdTokenClaims,
  fetchUserInfo,
  deriveUsername,
  resolveGroupFromClaims,
  resolveRedirectUri,
  type OidcUserInfo,
} from "@/lib/oidc";
import { getGatewaySettings } from "@/lib/settings";
import { randomBytes } from "node:crypto";

function parseCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return null;
  const pair = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  if (!pair) return null;
  return decodeURIComponent(pair.slice(name.length + 1));
}

function redirectWithError(origin: string, message: string, bind = false) {
  const target = bind ? "/dashboard" : "/login";
  const url = new URL(target, origin);
  url.searchParams.set("oidc_error", message);
  return NextResponse.redirect(url.toString(), 302);
}

export async function GET(request: Request) {
  const config = getOidcConfig();
  const url = new URL(request.url);
  const origin = url.origin;

  if (!config.enabled || !config.issuerUrl || !config.clientId) {
    return redirectWithError(origin, "OIDC 未启用");
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    const desc = url.searchParams.get("error_description") ?? error;
    return redirectWithError(origin, desc);
  }

  if (!code || !returnedState) {
    return redirectWithError(origin, "缺少授权参数");
  }

  const stateCookie = parseCookie(request.headers.get("cookie"), "oidc-state");
  if (!stateCookie) {
    return redirectWithError(origin, "状态验证失败，请重试");
  }

  let statePayload: { state: string; nonce: string; bind: boolean };
  try {
    statePayload = JSON.parse(stateCookie);
  } catch {
    return redirectWithError(origin, "状态验证失败");
  }

  if (statePayload.state !== returnedState) {
    return redirectWithError(origin, "状态验证失败");
  }

  const isBind = statePayload.bind;
  const redirectUri = resolveRedirectUri(config, request.url);

  let discovery;
  try {
    discovery = await fetchDiscovery(config.issuerUrl);
  } catch {
    return redirectWithError(origin, "无法连接 OIDC 提供商", isBind);
  }

  let tokenResponse;
  try {
    tokenResponse = await exchangeCode(
      discovery,
      config.clientId,
      config.clientSecret,
      code,
      redirectUri,
    );
  } catch {
    return redirectWithError(origin, "Token 交换失败", isBind);
  }

  let userInfo: OidcUserInfo | undefined;
  let rawClaims: Record<string, unknown> = {};
  try {
    if (tokenResponse.id_token) {
      const result = extractIdTokenClaims(
        tokenResponse.id_token,
        config.issuerUrl,
        config.clientId,
        statePayload.nonce,
      );
      rawClaims = result._claims;
      userInfo = result;
    }

    if (discovery.userinfo_endpoint && tokenResponse.access_token) {
      try {
        const ui = await fetchUserInfo(discovery, tokenResponse.access_token);
        rawClaims = { ...rawClaims, ...ui._claims };
        userInfo = {
          sub: ui.sub ?? userInfo?.sub,
          name: ui.name ?? userInfo?.name,
          preferred_username: ui.preferred_username ?? userInfo?.preferred_username,
          email: ui.email ?? userInfo?.email,
        };
      } catch (err) {
        if (!userInfo) throw err;
      }
    }

    if (!userInfo) throw new Error("No id_token and no userinfo");
  } catch {
    return redirectWithError(origin, "用户信息获取失败", isBind);
  }

  const issuer = config.issuerUrl.replace(/\/+$/, "");
  const clearStateCookie = (res: NextResponse) => {
    res.cookies.set("oidc-state", "", { httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: 0 });
    return res;
  };

  if (isBind) {
    const auth = requireWebAuthWithRefresh(request);
    if (!auth) {
      return clearStateCookie(redirectWithError(origin, "请先登录后再绑定", true));
    }

    const existingBind = gatewayDb
      .prepare("SELECT id FROM users WHERE oidc_issuer = ? AND oidc_subject = ? AND deleted_at IS NULL")
      .get(issuer, userInfo.sub) as { id: number } | undefined;

    if (existingBind && existingBind.id !== auth.user.id) {
      return clearStateCookie(redirectWithError(origin, "该 OIDC 账号已被其他用户绑定", true));
    }

    const claimGroupId = resolveGroupFromClaims(rawClaims, config.groupClaim);
    if (claimGroupId !== null) {
      gatewayDb
        .prepare("UPDATE users SET oidc_issuer = ?, oidc_subject = ?, group_id = ? WHERE id = ?")
        .run(issuer, userInfo.sub, claimGroupId, auth.user.id);
    } else {
      gatewayDb
        .prepare("UPDATE users SET oidc_issuer = ?, oidc_subject = ? WHERE id = ?")
        .run(issuer, userInfo.sub, auth.user.id);
    }

    const res = NextResponse.redirect(`${origin}/dashboard?oidc_bound=1`, 302);
    return clearStateCookie(res);
  }

  let user = gatewayDb
    .prepare("SELECT * FROM users WHERE oidc_issuer = ? AND oidc_subject = ? AND enabled = 1 AND deleted_at IS NULL")
    .get(issuer, userInfo.sub) as DbUser | undefined;

  if (!user) {
    if (!config.autoRegister) {
      return clearStateCookie(redirectWithError(origin, "未找到绑定的账号，且自动注册已关闭"));
    }

    const settings = getGatewaySettings();
    const adminCount = gatewayDb
      .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND deleted_at IS NULL")
      .get() as { count: number };

    const role: "admin" | "user" = adminCount.count === 0 ? "admin" : "user";
    const claimGroupId = resolveGroupFromClaims(rawClaims, config.groupClaim);
    const defaultGroup = gatewayDb
      .prepare("SELECT id FROM groups WHERE is_default = 1 AND deleted_at IS NULL")
      .get() as { id: number } | undefined;
    const groupId = claimGroupId ?? defaultGroup?.id ?? null;

    let username = deriveUsername(userInfo);

    const existing = gatewayDb
      .prepare("SELECT id FROM users WHERE username = ?")
      .get(username) as { id: number } | undefined;
    if (existing) {
      username = username + randomBytes(3).toString("hex");
    }

    const placeholderHash = await hashPassword(randomBytes(32).toString("hex"));

    gatewayDb
      .prepare(
        `INSERT INTO users (username, password_hash, role, group_id, oidc_issuer, oidc_subject,
           rpm, qps, tpm, quota_tokens, quota_requests, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        username,
        placeholderHash,
        role,
        groupId,
        issuer,
        userInfo.sub,
        settings.default_rpm,
        settings.default_qps,
        settings.default_tpm,
        settings.default_quota_tokens < 0 ? null : settings.default_quota_tokens,
        settings.default_quota_requests < 0 ? null : settings.default_quota_requests,
      );

    user = gatewayDb
      .prepare("SELECT * FROM users WHERE oidc_issuer = ? AND oidc_subject = ? AND deleted_at IS NULL")
      .get(issuer, userInfo.sub) as DbUser | undefined;

    if (!user) {
      return clearStateCookie(redirectWithError(origin, "自动注册失败"));
    }
  }

  if (config.groupClaim) {
    const claimGroupId = resolveGroupFromClaims(rawClaims, config.groupClaim);
    if (claimGroupId !== null && claimGroupId !== user.group_id) {
      gatewayDb
        .prepare("UPDATE users SET group_id = ? WHERE id = ?")
        .run(claimGroupId, user.id);
    }
  }

  const tokens = issueAuthTokens(user);
  const dashboardUrl = user.role === "admin" ? "/dashboard" : "/dashboard/keys";
  const res = NextResponse.redirect(`${origin}${dashboardUrl}?oidc_login=1`, 302);
  applyAuthCookies(res, tokens);
  return clearStateCookie(res);
}

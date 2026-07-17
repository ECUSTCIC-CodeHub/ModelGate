export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { applyAuthCookies, hashPassword, issueAuthTokens, requireWebAuthWithRefresh, signOidcPendingToken, OIDC_PENDING_COOKIE_NAME } from "@/lib/auth/auth";
import { gatewayDb, type DbUser } from "@/lib/core/db";
import { featureUnavailableMessage, isFeatureEnabled } from "@/lib/core/features";
import {
  getOidcConfig,
  fetchDiscovery,
  exchangeCode,
  extractIdTokenClaims,
  fetchUserInfo,
  deriveUsername,
  resolveGroupFromClaims,
  syncUserGroupFromClaims,
  resolveRedirectUri,
  getPublicOrigin,
  normalizeOidcIssuerUrl,
  type OidcUserInfo,
} from "@/lib/auth/oidc";
import { randomBytes } from "node:crypto";
import { getGatewaySettings } from "@/lib/core/settings";

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
  const config = await getOidcConfig();
  const url = new URL(request.url);
  const origin = await getPublicOrigin(request.url);

  if (!isFeatureEnabled("oidc")) {
    return redirectWithError(origin, featureUnavailableMessage("OIDC"));
  }

  if (!config.enabled || !config.issuerUrl || !config.clientId) {
    return redirectWithError(origin, "OIDC 未启用");
  }

  const stateCookie = parseCookie(request.headers.get("cookie"), "oidc-state");
  let statePayload: { state: string; nonce: string; bind: boolean } | null = null;
  try {
    if (stateCookie) statePayload = JSON.parse(stateCookie);
  } catch {}
  const isBind = statePayload?.bind ?? false;

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    const desc = url.searchParams.get("error_description") ?? error;
    return redirectWithError(origin, desc, isBind);
  }

  if (!code || !returnedState) {
    return redirectWithError(origin, "缺少授权参数", isBind);
  }

  if (!statePayload) {
    return redirectWithError(origin, "状态验证失败，请重试", isBind);
  }

  if (statePayload.state !== returnedState) {
    return redirectWithError(origin, "状态验证失败", isBind);
  }
  const redirectUri = await resolveRedirectUri(request.url);

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
      const result = await extractIdTokenClaims(
        tokenResponse.id_token,
        discovery.jwks_uri,
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

  const issuer = normalizeOidcIssuerUrl(config.issuerUrl);
  const clearStateCookie = (res: NextResponse) => {
    res.cookies.set("oidc-state", "", { httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: 0 });
    return res;
  };

  if (isBind) {
    const auth = await requireWebAuthWithRefresh(request);
    if (!auth) {
      return clearStateCookie(redirectWithError(origin, "请先登录后再绑定", true));
    }

    const existingBind = await gatewayDb
      .queryOne<{ id: number }>("SELECT id FROM users WHERE oidc_issuer = ? AND oidc_subject = ? AND deleted_at IS NULL", [issuer, userInfo.sub]);

    if (existingBind && existingBind.id !== auth.user.id) {
      return clearStateCookie(redirectWithError(origin, "该 OIDC 账号已被其他用户绑定", true));
    }

    const email = userInfo.email?.toLowerCase() ?? null;
    await gatewayDb
      .execute("UPDATE users SET oidc_issuer = ?, oidc_subject = ?, email = COALESCE(?, email) WHERE id = ?", [issuer, userInfo.sub, email, auth.user.id]);
    await syncUserGroupFromClaims(auth.user.id, rawClaims, email);

    const res = NextResponse.redirect(`${origin}/dashboard?oidc_bound=1`, 302);
    return clearStateCookie(res);
  }

  let user = await gatewayDb
    .queryOne<DbUser>("SELECT * FROM users WHERE oidc_issuer = ? AND oidc_subject = ? AND enabled = 1 AND deleted_at IS NULL", [issuer, userInfo.sub]);

  if (!user) {
    const settings = await getGatewaySettings();
    const isOidcOnlyMode = settings.password_login_enabled === 0;

    if (isOidcOnlyMode) {
      if (!config.autoRegister) {
        const adminCount = await gatewayDb
          .queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND deleted_at IS NULL");
        if (adminCount!.count > 0) {
          return clearStateCookie(redirectWithError(origin, "OIDC 登录失败，请联系管理员"));
        }
      }

      const stripped = { ...rawClaims };
      for (const k of ["at_hash", "c_hash", "auth_time", "iat", "exp", "nonce"]) delete stripped[k];
      const pendingToken = signOidcPendingToken({
        sub: userInfo.sub,
        issuer,
        name: userInfo.name,
        preferred_username: userInfo.preferred_username,
        email: userInfo.email,
        rawClaims: stripped,
      });
      const res = NextResponse.redirect(`${origin}/oidc-bind`, 302);
      res.cookies.set(OIDC_PENDING_COOKIE_NAME, pendingToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: false,
        path: "/",
        maxAge: 600,
      });
      return clearStateCookie(res);
    }

    if (!config.autoRegister) {
      return clearStateCookie(redirectWithError(origin, "OIDC 登录失败，请联系管理员"));
    }

    const claimGroupId = await resolveGroupFromClaims(rawClaims);
    const email = userInfo.email?.toLowerCase() ?? null;

    if (email) {
      const emailUser = await gatewayDb
        .queryOne<DbUser>("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL", [email]);
      if (emailUser) {
        await gatewayDb
          .execute("UPDATE users SET oidc_issuer = NULL, oidc_subject = NULL WHERE oidc_issuer = ? AND oidc_subject = ? AND id != ?", [issuer, userInfo.sub, emailUser.id]);
        await gatewayDb
          .execute("UPDATE users SET oidc_issuer = ?, oidc_subject = ? WHERE id = ?", [issuer, userInfo.sub, emailUser.id]);
        user = emailUser;
      }
    }

    if (!user) {
    const placeholderHash = await hashPassword(randomBytes(32).toString("hex"));

    const registerUser = async () => gatewayDb.transaction(async (tx) => {
      const adminCount = (await tx
        .queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND deleted_at IS NULL"))!;
      const role: "admin" | "user" = adminCount.count === 0 ? "admin" : "user";

      const defaultGroup = await tx
        .queryOne<{ id: number }>("SELECT id FROM `groups` WHERE is_default = 1 AND deleted_at IS NULL");
      const groupId = claimGroupId ?? defaultGroup?.id ?? null;

      let username = deriveUsername(userInfo);
      const existing = await tx
        .queryOne<{ id: number }>("SELECT id FROM users WHERE username = ?", [username]);
      if (existing) {
        username = username + randomBytes(3).toString("hex");
      }

      await tx
        .execute(
          `INSERT INTO users (username, password_hash, role, group_id, oidc_issuer, oidc_subject, email,
             rpm, qps, tpm, quota_tokens, quota_requests, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, -1, -1, -1, NULL, NULL, 1)`,
          [username, placeholderHash, role, groupId, issuer, userInfo.sub, email],
        );

      return tx
        .queryOne<DbUser>("SELECT * FROM users WHERE oidc_issuer = ? AND oidc_subject = ? AND deleted_at IS NULL", [issuer, userInfo.sub]);
    });

    user = await registerUser();

    if (!user) {
      return clearStateCookie(redirectWithError(origin, "自动注册失败"));
    }
    }
  }

  {
    await syncUserGroupFromClaims(user.id, rawClaims, userInfo.email?.toLowerCase() ?? null);
  }

  const tokens = issueAuthTokens(user);
  const dashboardUrl = "/dashboard";
  const res = NextResponse.redirect(`${origin}${dashboardUrl}?oidc_login=1`, 302);
  applyAuthCookies(res, tokens);
  return clearStateCookie(res);
}

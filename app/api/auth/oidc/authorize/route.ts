export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { featureUnavailableMessage, modelGateFeatures } from "@/lib/features";
import {
  getOidcConfig,
  fetchDiscovery,
  generateState,
  generateNonce,
  buildAuthorizationUrl,
  resolveRedirectUri,
} from "@/lib/oidc";

export async function GET(request: Request) {
  if (!modelGateFeatures.oidc) {
    return jsonError(featureUnavailableMessage("OIDC"), 404);
  }

  const config = getOidcConfig();
  if (!config.enabled || !config.issuerUrl || !config.clientId) {
    return jsonError("OIDC 未启用或配置不完整", 400);
  }

  const url = new URL(request.url);
  const bind = url.searchParams.get("bind") === "1";
  const redirectUri = resolveRedirectUri(request.url);

  let discovery;
  try {
    discovery = await fetchDiscovery(config.issuerUrl);
  } catch {
    return jsonError("无法连接 OIDC 提供商", 502);
  }

  const state = generateState();
  const nonce = generateNonce();

  const statePayload = JSON.stringify({ state, nonce, bind });

  const authUrl = buildAuthorizationUrl(
    discovery,
    config.clientId,
    redirectUri,
    config.scopes,
    state,
    nonce,
  );

  const response = NextResponse.redirect(authUrl, 302);
  response.cookies.set("oidc-state", statePayload, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 600,
  });
  return response;
}

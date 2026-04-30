import { randomBytes, createHash } from "node:crypto";
import { gatewayDb } from "@/lib/db";
import { getGatewaySettings } from "@/lib/settings";

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
};

type OidcTokenResponse = {
  access_token: string;
  id_token?: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
};

export type OidcUserInfo = {
  sub: string;
  name?: string;
  preferred_username?: string;
  email?: string;
};

const discoveryCache = new Map<string, { data: OidcDiscovery; expiresAt: number }>();
const DISCOVERY_TTL_MS = 5 * 60 * 1000;

export function getOidcConfig() {
  const s = getGatewaySettings();
  return {
    enabled: s.oidc_enabled === 1,
    issuerUrl: s.oidc_issuer_url,
    clientId: s.oidc_client_id,
    clientSecret: s.oidc_client_secret,
    scopes: s.oidc_scopes,
    autoRegister: s.oidc_auto_register === 1,
    buttonText: s.oidc_button_text,
    groupClaim: s.oidc_group_claim,
  };
}

export async function fetchDiscovery(issuerUrl: string): Promise<OidcDiscovery> {
  const now = Date.now();
  const cached = discoveryCache.get(issuerUrl);
  if (cached && cached.expiresAt > now) return cached.data;

  const url = issuerUrl.replace(/\/+$/, "") + "/.well-known/openid-configuration";
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`);
  const data = (await response.json()) as OidcDiscovery;
  if (!data.authorization_endpoint || !data.token_endpoint) {
    throw new Error("OIDC discovery response missing required endpoints");
  }
  discoveryCache.set(issuerUrl, { data, expiresAt: now + DISCOVERY_TTL_MS });
  return data;
}

export function generateState(): string {
  return randomBytes(32).toString("hex");
}

export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

export function buildAuthorizationUrl(
  discovery: OidcDiscovery,
  clientId: string,
  redirectUri: string,
  scopes: string,
  state: string,
  nonce: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
    nonce,
  });
  const sep = discovery.authorization_endpoint.includes("?") ? "&" : "?";
  return `${discovery.authorization_endpoint}${sep}${params.toString()}`;
}

export async function exchangeCode(
  discovery: OidcDiscovery,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<OidcTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OIDC token exchange failed: ${response.status} ${text}`);
  }

  return (await response.json()) as OidcTokenResponse;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT structure");
  const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
  return JSON.parse(payload) as Record<string, unknown>;
}

export function extractIdTokenClaims(
  idToken: string,
  expectedIssuer: string,
  expectedAudience: string,
  expectedNonce?: string,
): OidcUserInfo & { _claims: Record<string, unknown> } {
  const claims = decodeJwtPayload(idToken);

  const iss = claims.iss as string | undefined;
  const expectedIssNormalized = expectedIssuer.replace(/\/+$/, "");
  const issNormalized = (iss ?? "").replace(/\/+$/, "");
  if (issNormalized !== expectedIssNormalized) {
    throw new Error(`ID token issuer mismatch: ${iss}`);
  }

  const aud = claims.aud;
  const audList = Array.isArray(aud) ? aud : [aud];
  if (!audList.includes(expectedAudience)) {
    throw new Error("ID token audience mismatch");
  }

  const exp = claims.exp as number | undefined;
  if (exp && exp < Math.floor(Date.now() / 1000)) {
    throw new Error("ID token expired");
  }

  if (expectedNonce && claims.nonce !== expectedNonce) {
    throw new Error("ID token nonce mismatch");
  }

  const sub = claims.sub as string | undefined;
  if (!sub) throw new Error("ID token missing sub claim");

  return {
    sub,
    name: (claims.name as string) ?? undefined,
    preferred_username: (claims.preferred_username as string) ?? undefined,
    email: (claims.email as string) ?? undefined,
    _claims: claims,
  };
}

export async function fetchUserInfo(
  discovery: OidcDiscovery,
  accessToken: string,
): Promise<OidcUserInfo> {
  if (!discovery.userinfo_endpoint) throw new Error("No userinfo endpoint");
  const response = await fetch(discovery.userinfo_endpoint, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Userinfo fetch failed: ${response.status}`);
  const data = (await response.json()) as Record<string, unknown>;
  const sub = data.sub as string | undefined;
  if (!sub) throw new Error("Userinfo missing sub");
  return {
    sub,
    name: (data.name as string) ?? undefined,
    preferred_username: (data.preferred_username as string) ?? undefined,
    email: (data.email as string) ?? undefined,
  };
}

export function deriveUsername(info: OidcUserInfo): string {
  if (info.preferred_username) {
    const cleaned = info.preferred_username.replace(/[^A-Za-z0-9]/g, "");
    if (cleaned.length >= 3) return cleaned;
  }
  if (info.email) {
    const local = info.email.split("@")[0].replace(/[^A-Za-z0-9]/g, "");
    if (local.length >= 3) return local;
  }
  if (info.name) {
    const cleaned = info.name.replace(/[^A-Za-z0-9]/g, "");
    if (cleaned.length >= 3) return cleaned;
  }
  return "oidc" + createHash("sha256").update(info.sub).digest("hex").slice(0, 8);
}

export function resolveGroupFromClaims(
  claims: Record<string, unknown>,
  groupClaim: string,
): number | null {
  if (!groupClaim) return null;

  const value = claims[groupClaim];
  if (value === undefined || value === null) return null;

  const claimValues = Array.isArray(value) ? value.map(String) : [String(value)];

  const groups = gatewayDb
    .prepare(
      "SELECT id, oidc_claim_value FROM groups WHERE oidc_claim_value IS NOT NULL AND oidc_claim_value != '' AND enabled = 1 AND deleted_at IS NULL",
    )
    .all() as Array<{ id: number; oidc_claim_value: string }>;

  for (const group of groups) {
    if (claimValues.includes(group.oidc_claim_value)) {
      return group.id;
    }
  }

  return null;
}

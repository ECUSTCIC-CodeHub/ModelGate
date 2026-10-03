import { randomBytes, createHash, createPublicKey } from "node:crypto";
import jwt, { type Algorithm } from "jsonwebtoken";
import { gatewayDb } from "@/lib/core/db";
import { parseClaimExpr, evaluateClaimExpr } from "@/lib/shared/claim-expr";
import { getGatewaySettings } from "@/lib/core/settings";
import { toMysqlDatetime } from "@/lib/core/db/datetime";

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

type OidcJwk = JsonWebKey & {
  alg?: string;
  kid?: string;
  use?: string;
};

const discoveryCache = new Map<string, { data: OidcDiscovery; expiresAt: number }>();
const jwksCache = new Map<string, { keys: OidcJwk[]; expiresAt: number }>();
// in-flight 去重：kid 未命中的强制刷新会在并发登录时被同时触发，
// 无共享 Promise 则每个请求各发一次 JWKS 请求（实测 20 并发 -> 20 次）
const jwksInFlight = new Map<string, Promise<OidcJwk[]>>();
const DISCOVERY_TTL_MS = 5 * 60 * 1000;
// 强制刷新的负缓存：任意私钥 + 随机 kid 的无效 token 都能触发强制刷新
// （串行约 1 请求/token，in-flight 去重只对同瞬并发有效）。同一 kid 刷新后
// 仍找不到时，短时间内不再重复刷新，把这个放大系数压到与 kid 数量无关
const jwksRefreshBackoff = new Map<string, number>();
const JWKS_REFRESH_BACKOFF_MS = 30_000;
const JWKS_REFRESH_BACKOFF_MAX_ENTRIES = 1000;

// 随机 kid 会让退避表无界增长：写入前先清过期项，仍超上限则整体清空
// （清空只弱化退避、不影响正确性）
function markJwksRefreshBackoff(key: string) {
  const now = Date.now();
  if (jwksRefreshBackoff.size >= JWKS_REFRESH_BACKOFF_MAX_ENTRIES) {
    for (const [k, until] of jwksRefreshBackoff) {
      if (until <= now) jwksRefreshBackoff.delete(k);
    }
    if (jwksRefreshBackoff.size >= JWKS_REFRESH_BACKOFF_MAX_ENTRIES) jwksRefreshBackoff.clear();
  }
  jwksRefreshBackoff.set(key, now + JWKS_REFRESH_BACKOFF_MS);
}

// 按 kid 退避挡不住「每次换一个随机 kid」的伪造请求（实测 50 个不同 kid
// 仍产生 50 次刷新），故再按 URI 限流：窗口内只允许一次强制刷新。
// 真实轮换后第一次刷新即可拿到新密钥，故不影响正常登录
const jwksForcedRefreshAt = new Map<string, number>();
const JWKS_FORCED_REFRESH_MIN_INTERVAL_MS = 10_000;

function canForceJwksRefresh(jwksUri: string): boolean {
  const last = jwksForcedRefreshAt.get(jwksUri) ?? 0;
  if (Date.now() - last < JWKS_FORCED_REFRESH_MIN_INTERVAL_MS) return false;
  jwksForcedRefreshAt.set(jwksUri, Date.now());
  return true;
}
const OIDC_ID_TOKEN_ALGORITHMS: Algorithm[] = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"];

export async function getOidcConfig() {
  const s = await getGatewaySettings();
  return {
    enabled: s.oidc_enabled === 1,
    issuerUrl: s.oidc_issuer_url,
    clientId: s.oidc_client_id,
    clientSecret: s.oidc_client_secret,
    scopes: s.oidc_scopes,
    autoRegister: s.oidc_auto_register === 1,
    buttonText: s.oidc_button_text,
  };
}

export async function getPublicOrigin(requestUrl: string): Promise<string> {
  const s = await getGatewaySettings();
  const base = (s.public_base_url ?? "").trim().replace(/\/+$/, "");
  if (base && isValidPublicBaseUrl(base)) return base;
  return new URL(requestUrl).origin;
}

export const OIDC_REDIRECT_URI_HINT = "OIDC 登录需要先在设置中配置对外服务域名 public_base_url";

// public_base_url 会被直接拼接成 redirect_uri 回传给 IdP，因此除协议与主机外，
// 还必须排除 userinfo（凭据会随连接泄漏给 IdP）、query/hash（拼接后地址不成立）与空端口。
// new URL 会剥掉内嵌的 \t\n\r 并把空 query/hash 归一化，故先用原始串挡掉这些写法。
export function isValidPublicBaseUrl(value: string): boolean {
  if (/\s/.test(value) || value.includes("?") || value.includes("#")) return false;
  const authority = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").split("/")[0];
  if (authority === "" || authority.endsWith(":")) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname !== "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}

export type RedirectUriResult = { ok: true; redirectUri: string } | { ok: false; message: string };

export type PublicBaseUrlResult = { ok: true; baseUrl: string } | { ok: false; message: string };

export async function resolvePublicBaseUrl(): Promise<PublicBaseUrlResult> {
  const s = await getGatewaySettings();
  const base = (s.public_base_url ?? "").trim().replace(/\/+$/, "");
  if (!base || !isValidPublicBaseUrl(base)) return { ok: false, message: OIDC_REDIRECT_URI_HINT };
  return { ok: true, baseUrl: base };
}

export async function resolveRedirectUri(): Promise<RedirectUriResult> {
  const base = await resolvePublicBaseUrl();
  if (!base.ok) return { ok: false, message: base.message };
  return { ok: true, redirectUri: `${base.baseUrl}/api/auth/oidc/callback` };
}

export function normalizeOidcIssuerUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (url.endsWith("/.well-known/openid-configuration")) {
    url = url.slice(0, -"/.well-known/openid-configuration".length);
  }
  return url;
}

export async function fetchDiscovery(issuerUrl: string): Promise<OidcDiscovery> {
  const normalized = normalizeOidcIssuerUrl(issuerUrl);
  const now = Date.now();
  const cached = discoveryCache.get(normalized);
  if (cached && cached.expiresAt > now) return cached.data;

  const url = normalized + "/.well-known/openid-configuration";
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`);
  const data = (await response.json()) as OidcDiscovery;
  if (!data.authorization_endpoint || !data.token_endpoint) {
    throw new Error("OIDC discovery response missing required endpoints");
  }
  discoveryCache.set(normalized, { data, expiresAt: now + DISCOVERY_TTL_MS });
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

async function fetchJwks(jwksUri: string, forceRefresh = false): Promise<OidcJwk[]> {
  const now = Date.now();
  const cached = jwksCache.get(jwksUri);
  if (!forceRefresh && cached && cached.expiresAt > now) return cached.keys;

  // 同一 uri 的并发拉取共享一个 Promise：轮换瞬间多个登录会同时走到这里，
  // 若各自发请求会对 IdP 造成 N 倍瞬时负载
  const existing = jwksInFlight.get(jwksUri);
  if (existing) return existing;

  const pending = (async () => {
    const response = await fetch(jwksUri, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`OIDC JWKS fetch failed: ${response.status}`);
    const data = await response.json() as { keys?: OidcJwk[] };
    if (!Array.isArray(data.keys) || data.keys.length === 0) {
      throw new Error("OIDC JWKS response missing keys");
    }

    jwksCache.set(jwksUri, { keys: data.keys, expiresAt: Date.now() + DISCOVERY_TTL_MS });
    return data.keys;
  })();

  jwksInFlight.set(jwksUri, pending);
  try {
    return await pending;
  } finally {
    jwksInFlight.delete(jwksUri);
  }
}

function isAllowedIdTokenAlgorithm(alg: unknown): alg is Algorithm {
  return typeof alg === "string" && OIDC_ID_TOKEN_ALGORITHMS.includes(alg as Algorithm);
}

function decodeJwtHeader(token: string): jwt.JwtHeader {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded !== "object" || !decoded.header) {
    throw new Error("Invalid JWT structure");
  }
  return decoded.header;
}

function selectJwk(keys: OidcJwk[], header: jwt.JwtHeader, alg: Algorithm) {
  const candidates = keys.filter((key) => !header.kid || key.kid === header.kid);
  if (header.kid && candidates.length === 0) {
    throw new Error("ID token signing key not found");
  }

  const signingKeys = candidates.filter((key) => (!key.use || key.use === "sig") && (!key.alg || key.alg === alg));
  if (signingKeys.length === 0) {
    throw new Error("ID token signing key not usable");
  }
  return signingKeys[0];
}

// kid 未命中时刷新一次重试。
// 刷新失败不单独抛出：那会把「找不到签名密钥」误报成网络故障。
// 注意刷新失败时缓存未被污染（写缓存在 fetch 成功之后），故重试用的仍是同一份
// keys，判定结果不会改变；此处只为让错误同时带上两个原因，便于排查
// 无 kid 时 selectJwk 不会因 kid 抛「not found」，刷新拿到的是同一份列表、
// 结果必然相同，故不触发刷新
async function resolveJwkForHeader(
  header: jwt.JwtHeader,
  alg: Algorithm,
  cachedKeys: OidcJwk[],
  jwksUri: string,
): Promise<OidcJwk> {
  try {
    return selectJwk(cachedKeys, header, alg);
  } catch (error) {
    if (!header.kid) throw error;

    // 该 kid 刚刷新过且仍找不到，说明它是伪造的：退避期内不再发请求
    const backoffKey = `${jwksUri}\u0000${header.kid}`;
    if ((jwksRefreshBackoff.get(backoffKey) ?? 0) > Date.now()) throw error;
    // 同一 URI 的强制刷新限流，挡住「每次换一个随机 kid」的伪造请求
    if (!canForceJwksRefresh(jwksUri)) throw error;

    let refreshed: OidcJwk[];
    try {
      refreshed = await fetchJwks(jwksUri, true);
    } catch (refreshError) {
      markJwksRefreshBackoff(backoffKey);
      const original = error instanceof Error ? error.message : String(error);
      const reason = refreshError instanceof Error ? refreshError.message : String(refreshError);
      throw new Error(`${original}（JWKS 刷新失败：${reason}）`, { cause: refreshError });
    }
    try {
      return selectJwk(refreshed, header, alg);
    } catch (retryError) {
      markJwksRefreshBackoff(backoffKey);
      throw retryError;
    }
  }
}

async function verifyIdTokenSignature(idToken: string, jwksUri: string): Promise<Record<string, unknown>> {
  if (!jwksUri) throw new Error("OIDC discovery missing jwks_uri");
  const header = decodeJwtHeader(idToken);
  if (!isAllowedIdTokenAlgorithm(header.alg)) {
    throw new Error("ID token algorithm is not supported");
  }

  // kid 未命中缓存时强制刷新一次：轮换签名密钥后旧密钥立即失效，
  // 若不刷新，缓存 TTL（5 分钟）内所有登录都会报「找不到签名密钥」而失败
  const keys = await fetchJwks(jwksUri);
  const jwk = await resolveJwkForHeader(header, header.alg, keys, jwksUri);
  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  const claims = jwt.verify(idToken, publicKey, { algorithms: [header.alg] });
  if (!claims || typeof claims !== "object" || typeof claims === "string") {
    throw new Error("Invalid ID token payload");
  }
  return claims as Record<string, unknown>;
}

export async function extractIdTokenClaims(
  idToken: string,
  jwksUri: string,
  expectedIssuer: string,
  expectedAudience: string,
  expectedNonce?: string,
): Promise<OidcUserInfo & { _claims: Record<string, unknown> }> {
  const claims = await verifyIdTokenSignature(idToken, jwksUri);

  const iss = claims.iss as string | undefined;
  const expectedIssNormalized = normalizeOidcIssuerUrl(expectedIssuer);
  const issNormalized = normalizeOidcIssuerUrl(iss ?? "");
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
): Promise<OidcUserInfo & { _claims: Record<string, unknown> }> {
  if (!discovery.userinfo_endpoint) throw new Error("No userinfo endpoint");
  const response = await fetch(discovery.userinfo_endpoint, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Userinfo fetch failed: ${response.status}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  const sub = data.sub as string | undefined;
  if (!sub) throw new Error("Userinfo missing sub");
  return {
    sub,
    name: (data.name as string) ?? undefined,
    preferred_username: (data.preferred_username as string) ?? undefined,
    email: (data.email as string) ?? undefined,
    _claims: data,
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

export async function resolveGroupFromClaims(
  claims: Record<string, unknown>,
): Promise<number | null> {
  const groups = await gatewayDb.query<{ id: number; oidc_claim_expr: string }>(
    "SELECT id, oidc_claim_expr FROM `groups` WHERE oidc_claim_expr IS NOT NULL AND oidc_claim_expr != '' AND enabled = 1 AND deleted_at IS NULL ORDER BY oidc_claim_priority DESC, id ASC",
  );

  for (const group of groups) {
    try {
      const ast = parseClaimExpr(group.oidc_claim_expr);
      if (evaluateClaimExpr(ast, claims)) return group.id;
    } catch {
      continue;
    }
  }

  return null;
}

export async function syncUserGroupFromClaims(
  userId: number,
  claims: Record<string, unknown>,
  email: string | null,
): Promise<void> {
  const lockRow = await gatewayDb
    .queryOne<{ group_locked: number }>("SELECT group_locked FROM users WHERE id = ?", [userId]);
  if (lockRow?.group_locked === 1) {
    if (email) {
      await gatewayDb.execute("UPDATE users SET email = COALESCE(?, email) WHERE id = ?", [email, userId]);
    }
    return;
  }

  const syncedAt = toMysqlDatetime(new Date());
  const claimGroupId = await resolveGroupFromClaims(claims);
  if (claimGroupId !== null) {
    await gatewayDb
      .execute("UPDATE users SET group_id = ?, oidc_group_synced_at = ?, email = COALESCE(?, email) WHERE id = ?", [claimGroupId, syncedAt, email, userId]);
    return;
  }

  const current = await gatewayDb
    .queryOne<{ group_id: number | null }>("SELECT group_id FROM users WHERE id = ?", [userId]);
  const currentGroupId = current?.group_id ?? null;

  const currentIsOidcMapped = currentGroupId !== null
    && (await gatewayDb
      .queryOne<{ id: number }>(
        "SELECT id FROM `groups` WHERE id = ? AND oidc_claim_expr IS NOT NULL AND oidc_claim_expr != '' AND deleted_at IS NULL",
        [currentGroupId],
      )) !== null;

  if (!currentIsOidcMapped) {
    if (email) {
      await gatewayDb.execute("UPDATE users SET email = ?, oidc_group_synced_at = NULL WHERE id = ?", [email, userId]);
    } else {
      await gatewayDb.execute("UPDATE users SET oidc_group_synced_at = NULL WHERE id = ?", [userId]);
    }
    return;
  }

  const defaultGroup = await gatewayDb
    .queryOne<{ id: number }>("SELECT id FROM `groups` WHERE is_default = 1 AND deleted_at IS NULL");
  await gatewayDb
    .execute("UPDATE users SET group_id = ?, oidc_group_synced_at = NULL, email = COALESCE(?, email) WHERE id = ?", [defaultGroup?.id ?? null, email, userId]);
}

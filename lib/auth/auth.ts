import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { NextResponse } from "next/server";
import { gatewayDb, type DbUser } from "@/lib/core/db";
import { parseBearerToken } from "@/lib/core/http";
import { AUTH_DISABLED, getNoAuthContext } from "@/lib/auth/no-auth";

declare global {
  var __jwtAccessSecret__: string | undefined;
  var __jwtRefreshSecret__: string | undefined;
}

function getAccessSecret(): string {
  if (process.env.JWT_ACCESS_SECRET) return process.env.JWT_ACCESS_SECRET;
  if (!globalThis.__jwtAccessSecret__) globalThis.__jwtAccessSecret__ = randomBytes(32).toString("hex");
  return globalThis.__jwtAccessSecret__;
}

function getRefreshSecret(): string {
  if (process.env.JWT_REFRESH_SECRET) return process.env.JWT_REFRESH_SECRET;
  if (!globalThis.__jwtRefreshSecret__) globalThis.__jwtRefreshSecret__ = randomBytes(32).toString("hex");
  return globalThis.__jwtRefreshSecret__;
}
function getAccessExpiresSeconds(): number {
  return Number(process.env.JWT_ACCESS_EXPIRES_SECONDS ?? 900);
}

function getRefreshExpiresSeconds(): number {
  return Number(process.env.JWT_REFRESH_EXPIRES_SECONDS ?? 604800);
}
export const ACCESS_COOKIE_NAME = "vlm-access-token";
export const REFRESH_COOKIE_NAME = "vlm-refresh-token";

type TokenType = "access" | "refresh";

type TokenPayload = {
  sub: string;
  role: "admin" | "user";
  username: string;
  type: TokenType;
};

export type AuthContext = {
  user: Omit<DbUser, "password_hash" | "totp_secret">;
  token: string;
};

export function signAccessToken(user: Pick<DbUser, "id" | "role" | "username">) {
  return jwt.sign(
    {
      sub: String(user.id),
      role: user.role,
      username: user.username,
      type: "access",
    } satisfies TokenPayload,
    getAccessSecret(),
    { expiresIn: getAccessExpiresSeconds() },
  );
}

export function signRefreshToken(user: Pick<DbUser, "id" | "role" | "username">) {
  return jwt.sign(
    {
      sub: String(user.id),
      role: user.role,
      username: user.username,
      type: "refresh",
    } satisfies TokenPayload,
    getRefreshSecret(),
    { expiresIn: getRefreshExpiresSeconds() },
  );
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, getAccessSecret()) as TokenPayload;
}

export function verifyRefreshToken(token: string) {
  return jwt.verify(token, getRefreshSecret()) as TokenPayload;
}

export type OidcPendingPayload = {
  sub: string;
  issuer: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  rawClaims: Record<string, unknown>;
  type: "oidc_pending";
};

export type TotpPendingPayload = {
  sub: string;
  username: string;
  role: "admin" | "user";
  type: "totp_pending";
};

const OIDC_PENDING_EXPIRES_SECONDS = 600;
export const OIDC_PENDING_COOKIE_NAME = "oidc-pending";

export function signOidcPendingToken(payload: Omit<OidcPendingPayload, "type">): string {
  return jwt.sign({ ...payload, type: "oidc_pending" }, getAccessSecret(), { expiresIn: OIDC_PENDING_EXPIRES_SECONDS });
}

export function verifyOidcPendingToken(token: string): OidcPendingPayload | null {
  try {
    const decoded = jwt.verify(token, getAccessSecret()) as OidcPendingPayload;
    if (decoded.type !== "oidc_pending") return null;
    return decoded;
  } catch {
    return null;
  }
}

const TOTP_PENDING_EXPIRES_SECONDS = 300;

export function signTotpPendingToken(user: Pick<DbUser, "id" | "username" | "role">): string {
  return jwt.sign(
    { sub: String(user.id), username: user.username, role: user.role, type: "totp_pending" } satisfies TotpPendingPayload,
    getAccessSecret(),
    { expiresIn: TOTP_PENDING_EXPIRES_SECONDS },
  );
}

export function verifyTotpPendingToken(token: string): TotpPendingPayload | null {
  try {
    const decoded = jwt.verify(token, getAccessSecret()) as TotpPendingPayload;
    if (decoded.type !== "totp_pending") return null;
    return decoded;
  } catch {
    return null;
  }
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function sanitizeUser(user: DbUser): Omit<DbUser, "password_hash" | "totp_secret"> {
  const rest = { ...user };
  delete (rest as Partial<DbUser>).password_hash;
  delete (rest as Partial<DbUser>).totp_secret;
  return rest as Omit<DbUser, "password_hash" | "totp_secret">;
}

async function findEnabledUserById(id: number) {
  return gatewayDb.queryOne<DbUser>("SELECT * FROM users WHERE id = ? AND enabled = 1 AND deleted_at IS NULL", [id]);
}

function parseCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return null;
  const pair = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  if (!pair) return null;
  return decodeURIComponent(pair.slice(name.length + 1));
}

export function getAccessTokenFromRequest(request: Request) {
  const bearerToken = parseBearerToken(request.headers.get("authorization"));
  if (bearerToken) return bearerToken;
  return parseCookie(request.headers.get("cookie"), ACCESS_COOKIE_NAME);
}

export function getRefreshTokenFromRequest(request: Request) {
  return parseCookie(request.headers.get("cookie"), REFRESH_COOKIE_NAME);
}

export async function getAuthContextFromAccessToken(token: string): Promise<AuthContext | null> {
  const payload = verifyAccessToken(token);
  if (payload.type !== "access") return null;
  const user = await findEnabledUserById(Number(payload.sub));
  if (!user) return null;
  return { user: sanitizeUser(user), token };
}

async function noAuthContext(): Promise<AuthContext> {
  const { user } = await getNoAuthContext();
  return { user: sanitizeUser(user), token: "noauth" };
}

export async function requireWebAuth(request: Request): Promise<AuthContext | null> {
  if (AUTH_DISABLED) return noAuthContext();

  try {
    const token = getAccessTokenFromRequest(request);
    if (!token) return null;
    return getAuthContextFromAccessToken(token);
  } catch {
    return null;
  }
}

export async function requireWebAuthWithRefresh(request: Request): Promise<AuthContext | null> {
  if (AUTH_DISABLED) return noAuthContext();

  const auth = await requireWebAuth(request);
  if (auth) return auth;

  try {
    const refreshToken = getRefreshTokenFromRequest(request);
    if (!refreshToken) return null;
    const payload = verifyRefreshToken(refreshToken);
    if (payload.type !== "refresh") return null;
    const user = await findEnabledUserById(Number(payload.sub));
    if (!user) return null;
    return { user: sanitizeUser(user), token: refreshToken };
  } catch {
    return null;
  }
}

export function requireRole(auth: AuthContext, role: "admin" | "user") {
  if (role === "user") return true;
  return auth.user.role === "admin";
}

export function issueAuthTokens(user: Pick<DbUser, "id" | "username" | "role">) {
  return {
    access_token: signAccessToken(user),
    refresh_token: signRefreshToken(user),
    token_type: "Bearer",
    expires_in_seconds: getAccessExpiresSeconds(),
  };
}

function buildCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: false,
    path: "/",
    maxAge,
  };
}

export function applyAuthCookies(
  response: NextResponse,
  tokens: Pick<ReturnType<typeof issueAuthTokens>, "access_token" | "refresh_token">,
) {
  response.cookies.set(ACCESS_COOKIE_NAME, tokens.access_token, buildCookieOptions(getAccessExpiresSeconds()));
  response.cookies.set(REFRESH_COOKIE_NAME, tokens.refresh_token, buildCookieOptions(getRefreshExpiresSeconds()));
  return response;
}

export function clearAuthCookies(response: NextResponse) {
  response.cookies.set(ACCESS_COOKIE_NAME, "", buildCookieOptions(0));
  response.cookies.set(REFRESH_COOKIE_NAME, "", buildCookieOptions(0));
  return response;
}

export async function getServerProfileFromCookieStore(cookieStore: { get: (name: string) => { value: string } | undefined }) {
  if (AUTH_DISABLED) return (await noAuthContext()).user;

  const accessToken = cookieStore.get(ACCESS_COOKIE_NAME)?.value;
  const refreshToken = cookieStore.get(REFRESH_COOKIE_NAME)?.value;

  try {
    if (accessToken) {
      const accessUser = (await getAuthContextFromAccessToken(accessToken))?.user;
      if (accessUser) return accessUser;
    }
  } catch {}

  try {
    if (!refreshToken) return null;
    const payload = verifyRefreshToken(refreshToken);
    if (payload.type !== "refresh") return null;
    const user = await findEnabledUserById(Number(payload.sub));
    return user ? sanitizeUser(user) : null;
  } catch {
    return null;
  }
}

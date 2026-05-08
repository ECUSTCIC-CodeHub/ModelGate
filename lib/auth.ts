import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { NextResponse } from "next/server";
import { gatewayDb, type DbUser } from "@/lib/db";
import { parseBearerToken } from "@/lib/http";
import { AUTH_DISABLED, getNoAuthContext } from "@/lib/no-auth";

declare global {
  var __jwtAccessSecret__: string | undefined;
  var __jwtRefreshSecret__: string | undefined;
}

function resolveSecret(envKey: string, globalKey: "__jwtAccessSecret__" | "__jwtRefreshSecret__"): string {
  if (process.env[envKey]) return process.env[envKey]!;
  if (!globalThis[globalKey]) globalThis[globalKey] = randomBytes(32).toString("hex");
  return globalThis[globalKey];
}

const ACCESS_SECRET = resolveSecret("JWT_ACCESS_SECRET", "__jwtAccessSecret__");
const REFRESH_SECRET = resolveSecret("JWT_REFRESH_SECRET", "__jwtRefreshSecret__");
const ACCESS_EXPIRES_SECONDS = Number(process.env.JWT_ACCESS_EXPIRES_SECONDS ?? 900);
const REFRESH_EXPIRES_SECONDS = Number(process.env.JWT_REFRESH_EXPIRES_SECONDS ?? 604800);
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
  user: Omit<DbUser, "password_hash">;
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
    ACCESS_SECRET,
    { expiresIn: ACCESS_EXPIRES_SECONDS },
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
    REFRESH_SECRET,
    { expiresIn: REFRESH_EXPIRES_SECONDS },
  );
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, ACCESS_SECRET) as TokenPayload;
}

export function verifyRefreshToken(token: string) {
  return jwt.verify(token, REFRESH_SECRET) as TokenPayload;
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function sanitizeUser(user: DbUser): Omit<DbUser, "password_hash"> {
  const rest = { ...user };
  delete (rest as Partial<DbUser>).password_hash;
  return rest as Omit<DbUser, "password_hash">;
}

function findEnabledUserById(id: number) {
  return gatewayDb
    .prepare("SELECT * FROM users WHERE id = ? AND enabled = 1 AND deleted_at IS NULL")
    .get(id) as DbUser | undefined;
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

export function getAuthContextFromAccessToken(token: string): AuthContext | null {
  const payload = verifyAccessToken(token);
  if (payload.type !== "access") return null;
  const user = findEnabledUserById(Number(payload.sub));
  if (!user) return null;
  return { user: sanitizeUser(user), token };
}

function noAuthContext(): AuthContext {
  const { user } = getNoAuthContext();
  return { user: sanitizeUser(user), token: "noauth" };
}

export function requireWebAuth(request: Request): AuthContext | null {
  if (AUTH_DISABLED) return noAuthContext();

  try {
    const token = getAccessTokenFromRequest(request);
    if (!token) return null;
    return getAuthContextFromAccessToken(token);
  } catch {
    return null;
  }
}

export function requireWebAuthWithRefresh(request: Request): AuthContext | null {
  if (AUTH_DISABLED) return noAuthContext();

  const auth = requireWebAuth(request);
  if (auth) return auth;

  try {
    const refreshToken = getRefreshTokenFromRequest(request);
    if (!refreshToken) return null;
    const payload = verifyRefreshToken(refreshToken);
    if (payload.type !== "refresh") return null;
    const user = findEnabledUserById(Number(payload.sub));
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
    expires_in_seconds: ACCESS_EXPIRES_SECONDS,
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
  response.cookies.set(ACCESS_COOKIE_NAME, tokens.access_token, buildCookieOptions(ACCESS_EXPIRES_SECONDS));
  response.cookies.set(REFRESH_COOKIE_NAME, tokens.refresh_token, buildCookieOptions(REFRESH_EXPIRES_SECONDS));
  return response;
}

export function clearAuthCookies(response: NextResponse) {
  response.cookies.set(ACCESS_COOKIE_NAME, "", buildCookieOptions(0));
  response.cookies.set(REFRESH_COOKIE_NAME, "", buildCookieOptions(0));
  return response;
}

export function getServerProfileFromCookieStore(cookieStore: { get: (name: string) => { value: string } | undefined }) {
  if (AUTH_DISABLED) return noAuthContext().user;

  const accessToken = cookieStore.get(ACCESS_COOKIE_NAME)?.value;
  const refreshToken = cookieStore.get(REFRESH_COOKIE_NAME)?.value;

  try {
    if (accessToken) {
      const accessUser = getAuthContextFromAccessToken(accessToken)?.user;
      if (accessUser) return accessUser;
    }
  } catch {}

  try {
    if (!refreshToken) return null;
    const payload = verifyRefreshToken(refreshToken);
    if (payload.type !== "refresh") return null;
    const user = findEnabledUserById(Number(payload.sub));
    return user ? sanitizeUser(user) : null;
  } catch {
    return null;
  }
}

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { gatewayDb, type DbUser } from "@/lib/db";
import { parseBearerToken } from "@/lib/http";

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "dev-access-secret-change-me";
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? "dev-refresh-secret-change-me";
const ACCESS_EXPIRES_SECONDS = Number(process.env.JWT_ACCESS_EXPIRES_SECONDS ?? 900);
const REFRESH_EXPIRES_SECONDS = Number(process.env.JWT_REFRESH_EXPIRES_SECONDS ?? 604800);

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
    .prepare("SELECT * FROM users WHERE id = ? AND enabled = 1")
    .get(id) as DbUser | undefined;
}

export function requireWebAuth(request: Request): AuthContext | null {
  try {
    const token = parseBearerToken(request.headers.get("authorization"));
    if (!token) return null;
    const payload = verifyAccessToken(token);
    if (payload.type !== "access") return null;
    const user = findEnabledUserById(Number(payload.sub));
    if (!user) return null;
    return { user: sanitizeUser(user), token };
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

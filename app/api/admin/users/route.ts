export const dynamic = "force-dynamic";

import { z } from "zod";
import { hashPassword } from "@/lib/auth";
import { gatewayDb } from "@/lib/db";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";
import { getGatewaySettings } from "@/lib/settings";
import { USERNAME_SCHEMA } from "@/lib/username";
import { friendlyCredentialPayloadError } from "@/lib/validation";

const createSchema = z.object({
  username: USERNAME_SCHEMA,
  password: z.string().min(8),
  role: z.enum(["admin", "user"]).optional(),
  enabled: z.boolean().optional(),
  rpm: z.number().int().min(-1).optional(),
  qps: z.number().int().min(-1).optional(),
  tpm: z.number().int().min(-1).optional(),
  quota_tokens: z.number().int().min(-1).nullable().optional(),
  quota_requests: z.number().int().min(-1).nullable().optional(),
});

function normalizeQuota(value: number | null | undefined) {
  if (value === null || value === undefined || value < 0) return null;
  return value;
}

export async function GET(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  const keyword = (url.searchParams.get("keyword") ?? "").trim();

  const whereSql = keyword ? "WHERE deleted_at IS NULL AND username LIKE ?" : "WHERE deleted_at IS NULL";
  const whereArgs = keyword ? [`%${keyword}%`] : [];

  const rows = gatewayDb
    .prepare(
      `SELECT id, username, role, rpm, qps, tpm, quota_tokens, quota_requests, used_tokens, used_requests, enabled, created_at
       FROM users
       ${whereSql}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...whereArgs, limit, offset);

  const total = gatewayDb
    .prepare(
      `SELECT COUNT(*) AS total
       FROM users
       ${whereSql}`,
    )
    .get(...whereArgs) as { total: number };

  return jsonOk({
    data: rows,
    paging: { limit, offset, total: total.total ?? 0 },
  });
}

export async function POST(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return jsonError(friendlyCredentialPayloadError(parsed.error), 400);

  const existing = gatewayDb
    .prepare("SELECT id FROM users WHERE username = ?")
    .get(parsed.data.username) as { id: number } | undefined;
  if (existing) return jsonError("用户名已存在", 409);

  const settings = getGatewaySettings();

  const passwordHash = await hashPassword(parsed.data.password);
  const result = gatewayDb
    .prepare(
      `INSERT INTO users (
         username, password_hash, role, enabled,
         rpm, qps, tpm, quota_tokens, quota_requests
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      parsed.data.username,
      passwordHash,
      parsed.data.role ?? "user",
      parsed.data.enabled === false ? 0 : 1,
      parsed.data.rpm ?? settings.default_rpm,
      parsed.data.qps ?? settings.default_qps,
      parsed.data.tpm ?? settings.default_tpm,
      normalizeQuota(parsed.data.quota_tokens),
      normalizeQuota(parsed.data.quota_requests),
    );

  const row = gatewayDb
    .prepare(
      `SELECT id, username, role, rpm, qps, tpm, quota_tokens, quota_requests, used_tokens, used_requests, enabled, created_at
       FROM users WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(result.lastInsertRowid);

  return jsonOk({ message: "用户创建成功。", data: row }, 201);
}

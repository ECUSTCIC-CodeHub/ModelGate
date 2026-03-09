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
  quota_tokens: z.number().int().nonnegative().nullable().optional(),
  quota_requests: z.number().int().nonnegative().nullable().optional(),
});

export async function GET(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const rows = gatewayDb
    .prepare(
      `SELECT id, username, role, rpm, qps, tpm, quota_tokens, quota_requests, used_tokens, used_requests, enabled, created_at
       FROM users WHERE deleted_at IS NULL ORDER BY id DESC`,
    )
    .all();

  return jsonOk({ data: rows });
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
      parsed.data.quota_tokens ?? null,
      parsed.data.quota_requests ?? null,
    );

  const row = gatewayDb
    .prepare(
      `SELECT id, username, role, rpm, qps, tpm, quota_tokens, quota_requests, used_tokens, used_requests, enabled, created_at
       FROM users WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(result.lastInsertRowid);

  return jsonOk({ message: "用户创建成功。", data: row }, 201);
}

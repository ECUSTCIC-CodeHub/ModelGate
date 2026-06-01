export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/core/db";
import { ensureUser } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { generateGatewayKey } from "@/lib/auth/keys";

const createSchema = z.object({
  name: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
});

export async function GET(request: Request) {
  const guard = ensureUser(request);
  if ("error" in guard) return guard.error;

  const rows = gatewayDb
    .prepare(
      `SELECT id, key, name, user_id, used_tokens, used_requests, enabled, created_at
       FROM keys
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY id DESC`,
    )
    .all(guard.auth.user.id) as { key: string; [k: string]: unknown }[];

  return jsonOk({ data: rows });
}

export async function POST(request: Request) {
  const guard = ensureUser(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const keyCount = gatewayDb
    .prepare("SELECT COUNT(*) AS count FROM keys WHERE user_id = ? AND deleted_at IS NULL")
    .get(guard.auth.user.id) as { count: number };
  if (keyCount.count >= 50) {
    return jsonError("密钥数量已达上限", 400);
  }

  const apiKey = generateGatewayKey();
  const result = gatewayDb
    .prepare("INSERT INTO keys (key, name, user_id, enabled) VALUES (?, ?, ?, ?)")
    .run(apiKey, parsed.data.name?.trim() || "", guard.auth.user.id, parsed.data.enabled === false ? 0 : 1);

  const row = gatewayDb
    .prepare(
      `SELECT id, key, name, user_id, used_tokens, used_requests, enabled, created_at
       FROM keys
       WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(result.lastInsertRowid);
  return jsonOk({ message: "密钥创建成功。", data: row }, 201);
}

export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/db";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";
import { parseAllowedModelAliases, stringifyAllowedModelAliases } from "@/lib/model-access";

const updateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(200).nullable().optional(),
  qps: z.number().int().min(-1).optional(),
  rpm: z.number().int().min(-1).optional(),
  tpm: z.number().int().min(-1).optional(),
  quota_requests: z.number().int().min(-1).nullable().optional(),
  quota_tokens: z.number().int().min(-1).nullable().optional(),
  allowed_model_aliases: z.array(z.string().min(1)).optional(),
  is_default: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

function normalizeQuota(value: number | null | undefined) {
  if (value === null || value === undefined || value < 0) return null;
  return value;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(_request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const row = gatewayDb
    .prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.group_id = g.id AND u.deleted_at IS NULL) AS user_count
       FROM groups g
       WHERE g.id = ? AND g.deleted_at IS NULL`,
    )
    .get(id) as (Record<string, unknown> & { allowed_model_aliases: string }) | undefined;

  if (!row) return jsonError("用户组不存在", 404);

  return jsonOk({
    data: { ...row, allowed_model_aliases: parseAllowedModelAliases(row.allowed_model_aliases) },
  });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const existing = gatewayDb
    .prepare("SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL")
    .get(id) as
    | {
        id: number;
        name: string;
        description: string | null;
        qps: number;
        rpm: number;
        tpm: number;
        quota_requests: number | null;
        quota_tokens: number | null;
        allowed_model_aliases: string;
        is_default: number;
        enabled: number;
      }
    | undefined;

  if (!existing) return jsonError("用户组不存在", 404);

  if (parsed.data.name !== undefined && parsed.data.name !== existing.name) {
    const dup = gatewayDb
      .prepare("SELECT id FROM groups WHERE name = ? AND id != ? AND deleted_at IS NULL")
      .get(parsed.data.name, id) as { id: number } | undefined;
    if (dup) return jsonError("组名已存在", 409);
  }

  const setDefault = parsed.data.is_default === true;

  const merged = {
    name: parsed.data.name ?? existing.name,
    description:
      parsed.data.description === undefined
        ? existing.description
        : parsed.data.description?.trim() || null,
    qps: parsed.data.qps ?? existing.qps,
    rpm: parsed.data.rpm ?? existing.rpm,
    tpm: parsed.data.tpm ?? existing.tpm,
    quota_requests:
      parsed.data.quota_requests === undefined
        ? existing.quota_requests
        : normalizeQuota(parsed.data.quota_requests),
    quota_tokens:
      parsed.data.quota_tokens === undefined
        ? existing.quota_tokens
        : normalizeQuota(parsed.data.quota_tokens),
    allowed_model_aliases:
      parsed.data.allowed_model_aliases === undefined
        ? existing.allowed_model_aliases
        : stringifyAllowedModelAliases(parsed.data.allowed_model_aliases),
    is_default: setDefault ? 1 : (parsed.data.is_default === false ? 0 : existing.is_default),
    enabled:
      parsed.data.enabled === undefined
        ? existing.enabled
        : parsed.data.enabled ? 1 : 0,
  };

  const tx = gatewayDb.transaction(() => {
    if (setDefault) {
      gatewayDb.prepare("UPDATE groups SET is_default = 0 WHERE is_default = 1").run();
    }

    gatewayDb
      .prepare(
        `UPDATE groups
         SET name = ?, description = ?, qps = ?, rpm = ?, tpm = ?,
             quota_requests = ?, quota_tokens = ?, allowed_model_aliases = ?,
             is_default = ?, enabled = ?
         WHERE id = ?`,
      )
      .run(
        merged.name,
        merged.description,
        merged.qps,
        merged.rpm,
        merged.tpm,
        merged.quota_requests,
        merged.quota_tokens,
        merged.allowed_model_aliases,
        merged.is_default,
        merged.enabled,
        id,
      );
  });
  tx();

  const row = gatewayDb
    .prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.group_id = g.id AND u.deleted_at IS NULL) AS user_count
       FROM groups g
       WHERE g.id = ?`,
    )
    .get(id) as Record<string, unknown> & { allowed_model_aliases: string };

  return jsonOk({
    message: "用户组更新成功。",
    data: { ...row, allowed_model_aliases: parseAllowedModelAliases(row.allowed_model_aliases) },
  });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;

  const group = gatewayDb
    .prepare("SELECT id, is_default FROM groups WHERE id = ? AND deleted_at IS NULL")
    .get(id) as { id: number; is_default: number } | undefined;

  if (!group) return jsonError("用户组不存在", 404);
  if (group.is_default === 1) return jsonError("不能删除默认用户组", 400);

  const userCount = gatewayDb
    .prepare("SELECT COUNT(*) AS count FROM users WHERE group_id = ? AND deleted_at IS NULL")
    .get(id) as { count: number };

  if (userCount.count > 0) {
    return jsonError(`该组下仍有 ${userCount.count} 个用户，请先移除或转移用户`, 400);
  }

  gatewayDb
    .prepare("UPDATE groups SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(id);

  return jsonOk({ ok: true, message: "用户组删除成功。" });
}

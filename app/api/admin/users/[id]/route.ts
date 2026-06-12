export const dynamic = "force-dynamic";

import { z } from "zod";
import { hashPassword } from "@/lib/auth/auth";
import { gatewayDb } from "@/lib/core/db";
import { modelGateFeatures, requireFeature } from "@/lib/core/features";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { listExistingModelAliases, parseAllowedModelAliases, stringifyAllowedModelAliases } from "@/lib/gateway/model-access";
import { softDeleteUser } from "@/lib/services/soft-delete-service";
import { USERNAME_SCHEMA } from "@/lib/auth/username";

const updateSchema = z.object({
  username: USERNAME_SCHEMA.optional(),
  email: z.string().email().nullable().optional(),
  role: z.enum(["admin", "user"]).optional(),
  group_id: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
  rpm: z.number().int().min(-1).optional(),
  qps: z.number().int().min(-1).optional(),
  tpm: z.number().int().min(-1).optional(),
  quota_tokens: z.number().int().min(-1).nullable().optional(),
  quota_requests: z.number().int().min(-1).nullable().optional(),
  quota_period: z.number().int().min(0).nullable().optional(),
  period_quota_tokens: z.number().int().min(-1).nullable().optional(),
  period_quota_requests: z.number().int().min(-1).nullable().optional(),
  allowed_model_aliases: z.array(z.string().min(1)).optional(),
  note: z.string().max(500).nullable().optional(),
  new_password: z.string().min(8).optional(),
  reset_usage: z.enum(["all", "total", "period"]).optional(),
});

function normalizeQuota(value: number | null | undefined) {
  if (value === null || value === undefined || value < 0) return null;
  return value;
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);
  if (parsed.data.reset_usage === "period") {
    const unavailable = requireFeature("periodQuota");
    if (unavailable) return unavailable;
  }

  const existing = await gatewayDb
    .queryOne<{
        id: number;
        username: string;
        email: string | null;
        role: "admin" | "user";
        group_id: number | null;
        enabled: number;
        rpm: number;
        qps: number;
        tpm: number;
        quota_tokens: number | null;
        quota_requests: number | null;
        quota_period: number | null;
        period_quota_tokens: number | null;
        period_quota_requests: number | null;
        allowed_model_aliases: string;
        note: string | null;
      }>(
        `SELECT id, username, email, role, group_id, enabled, rpm, qps, tpm,
                quota_tokens, quota_requests,
                quota_period, period_quota_tokens, period_quota_requests,
                allowed_model_aliases, note
         FROM users WHERE id = ? AND deleted_at IS NULL`,
        [id],
      );

  if (!existing) return jsonError("用户不存在", 404);

  const willDisableAdmin =
    existing.role === "admin" &&
    existing.enabled === 1 &&
    (parsed.data.enabled === false || parsed.data.role === "user");
  if (willDisableAdmin) {
    const adminCount = (await gatewayDb
      .queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND enabled = 1 AND deleted_at IS NULL"))!;
    if (adminCount.count <= 1) {
      return jsonError("不能禁用或降级最后一个启用的管理员", 400);
    }
  }

  if (parsed.data.username !== undefined && parsed.data.username !== existing.username) {
    const duplicated = await gatewayDb
      .queryOne<{ id: number }>("SELECT id FROM users WHERE username = ? AND id != ?", [parsed.data.username, id]);
    if (duplicated) return jsonError("用户名已存在", 409);
  }

  if (parsed.data.group_id !== undefined && parsed.data.group_id !== null) {
    const group = await gatewayDb
      .queryOne<{ id: number }>("SELECT id FROM `groups` WHERE id = ? AND deleted_at IS NULL", [parsed.data.group_id]);
    if (!group) return jsonError("用户组不存在", 400);
  }

  const inputAliases = parsed.data.allowed_model_aliases ?? [];
  const existingAliases = await listExistingModelAliases(inputAliases);
  const droppedAliases = inputAliases.filter((a) => !existingAliases.includes(a));

  const merged = {
    ...existing,
    ...parsed.data,
    email:
      parsed.data.email === undefined
        ? existing.email
        : parsed.data.email?.trim() || null,
    group_id:
      parsed.data.group_id === undefined
        ? existing.group_id
        : parsed.data.group_id,
    quota_tokens:
      parsed.data.quota_tokens === undefined
        ? existing.quota_tokens
        : normalizeQuota(parsed.data.quota_tokens),
    quota_requests:
      parsed.data.quota_requests === undefined
        ? existing.quota_requests
        : normalizeQuota(parsed.data.quota_requests),
    quota_period:
      parsed.data.quota_period === undefined
        ? existing.quota_period
        : modelGateFeatures.periodQuota
          ? normalizeQuota(parsed.data.quota_period)
          : existing.quota_period,
    period_quota_tokens:
      parsed.data.period_quota_tokens === undefined
        ? existing.period_quota_tokens
        : modelGateFeatures.periodQuota
          ? normalizeQuota(parsed.data.period_quota_tokens)
          : existing.period_quota_tokens,
    period_quota_requests:
      parsed.data.period_quota_requests === undefined
        ? existing.period_quota_requests
        : modelGateFeatures.periodQuota
          ? normalizeQuota(parsed.data.period_quota_requests)
          : existing.period_quota_requests,
    allowed_model_aliases:
      parsed.data.allowed_model_aliases === undefined
        ? existing.allowed_model_aliases
        : stringifyAllowedModelAliases(existingAliases),
    note:
      parsed.data.note === undefined
        ? existing.note
        : parsed.data.note?.trim()
          ? parsed.data.note.trim()
          : null,
    enabled:
      parsed.data.enabled === undefined
        ? existing.enabled
        : parsed.data.enabled
          ? 1
          : 0,
  };

  const nextPasswordHash = parsed.data.new_password
    ? await hashPassword(parsed.data.new_password)
    : null;

  if (nextPasswordHash) {
    await gatewayDb
      .execute(
        `UPDATE users
         SET username = ?, email = ?, role = ?, group_id = ?, enabled = ?, rpm = ?, qps = ?, tpm = ?,
             quota_tokens = ?, quota_requests = ?,
             quota_period = ?, period_quota_tokens = ?, period_quota_requests = ?,
             allowed_model_aliases = ?, note = ?, password_hash = ?
         WHERE id = ?`,
        [
          merged.username,
          merged.email,
          merged.role,
          merged.group_id,
          merged.enabled,
          merged.rpm,
          merged.qps,
          merged.tpm,
          merged.quota_tokens,
          merged.quota_requests,
          merged.quota_period,
          merged.period_quota_tokens,
          merged.period_quota_requests,
          merged.allowed_model_aliases,
          merged.note,
          nextPasswordHash,
          id,
        ],
      );
  } else {
    await gatewayDb
      .execute(
        `UPDATE users
         SET username = ?, email = ?, role = ?, group_id = ?, enabled = ?, rpm = ?, qps = ?, tpm = ?,
             quota_tokens = ?, quota_requests = ?,
             quota_period = ?, period_quota_tokens = ?, period_quota_requests = ?,
             allowed_model_aliases = ?, note = ?
         WHERE id = ?`,
        [
          merged.username,
          merged.email,
          merged.role,
          merged.group_id,
          merged.enabled,
          merged.rpm,
          merged.qps,
          merged.tpm,
          merged.quota_tokens,
          merged.quota_requests,
          merged.quota_period,
          merged.period_quota_tokens,
          merged.period_quota_requests,
          merged.allowed_model_aliases,
          merged.note,
          id,
        ],
      );
  }

  if (parsed.data.reset_usage === "all" || parsed.data.reset_usage === "total") {
    await gatewayDb
      .execute("UPDATE users SET used_tokens = 0, used_requests = 0 WHERE id = ?", [id]);
    await gatewayDb
      .execute("UPDATE `keys` SET used_tokens = 0, used_requests = 0 WHERE user_id = ? AND deleted_at IS NULL", [id]);
  }
  if (modelGateFeatures.periodQuota && (parsed.data.reset_usage === "all" || parsed.data.reset_usage === "period")) {
    await gatewayDb
      .execute("UPDATE users SET period_used_tokens = 0, period_used_requests = 0, period_reset_at = NULL WHERE id = ?", [id]);
  }

  const row = (await gatewayDb
    .queryOne<{ allowed_model_aliases: string } & Record<string, unknown>>(
      `SELECT u.id, u.username, u.email, u.role, u.group_id, g.name AS group_name,
              u.rpm, u.qps, u.tpm, u.quota_tokens, u.quota_requests,
              u.quota_period, u.period_quota_tokens, u.period_quota_requests,
              u.period_used_tokens, u.period_used_requests, u.period_reset_at,
              u.used_tokens, u.used_requests, u.allowed_model_aliases, u.note, u.oidc_issuer, u.oidc_subject, u.enabled, u.created_at
       FROM users u
       LEFT JOIN \`groups\` g ON g.id = u.group_id AND g.deleted_at IS NULL
       WHERE u.id = ? AND u.deleted_at IS NULL`,
      [id],
    ))!;

  return jsonOk({
    message: parsed.data.reset_usage ? "用量已重置。" : "用户更新成功。",
    data: { ...row, allowed_model_aliases: parseAllowedModelAliases(row.allowed_model_aliases) },
    ...(droppedAliases.length > 0 ? { warnings: [`以下模型别名不存在，已忽略: ${droppedAliases.join(", ")}`] } : {}),
  });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const adminCount = (await gatewayDb.queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND enabled = 1 AND deleted_at IS NULL"))!;

  const target = await gatewayDb
    .queryOne<{ role: "admin" | "user"; enabled: number }>("SELECT role, enabled FROM users WHERE id = ? AND deleted_at IS NULL", [id]);

  if (!target) return jsonError("用户不存在", 404);
  if (target.role === "admin" && target.enabled === 1 && adminCount.count <= 1) {
    return jsonError("不能删除最后一个启用的管理员", 400);
  }

  await softDeleteUser(id);
  return jsonOk({ ok: true, message: "用户删除成功。" });
}

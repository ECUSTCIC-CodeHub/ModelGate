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
import { friendlyCredentialPayloadError, passwordSchema } from "@/lib/auth/validation";
import { readJsonBodyCapped } from "@/lib/core/request-body";
import { type EffectiveLimitsInput, getEffectiveLimits, getUserGroup } from "@/lib/gateway/effective-limits";
import { resolveEffectivePeriods } from "@/lib/gateway/quota";
import {
  parsePeriodCycles,
  resolveUserPeriodCycles,
  serializePeriodCycleState,
  validatePeriodCycles,
} from "@/lib/gateway/period-cycles";

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
  period_cycles: z.unknown().optional(),
  allowed_model_aliases: z.array(z.string().min(1)).optional(),
  note: z.string().max(500).nullable().optional(),
  new_password: passwordSchema().optional(),
  reset_usage: z.enum(["all", "total", "period"]).optional(),
  group_locked: z.boolean().optional(),
});

function normalizeQuota(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  if (value < 0) return -1;
  return value;
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const body = await readJsonBodyCapped(request);
  if (!body.ok) return jsonError("请求体过大", 413);
  const parsed = updateSchema.safeParse(body.data);
  if (!parsed.success) return jsonError(friendlyCredentialPayloadError(parsed.error), 400);
  if (parsed.data.reset_usage === "period") {
    const unavailable = requireFeature("periodQuota");
    if (unavailable) return unavailable;
  }

  const cycleValidation = validatePeriodCycles(parsed.data.period_cycles);
  if (!cycleValidation.valid) return jsonError(cycleValidation.error, 400);
  if (cycleValidation.cycles === undefined && parsed.data.period_cycles !== undefined) {
    return jsonError("重置周期未提交任何档位，如需清空请传空数组。", 400);
  }

  const existing = await gatewayDb
    .queryOne<{
        id: number;
        username: string;
        email: string | null;
        role: "admin" | "user";
        group_id: number | null;
        enabled: number;
        group_locked: number;
        rpm: number;
        qps: number;
        tpm: number;
        quota_tokens: number | null;
        quota_requests: number | null;
        period_cycles: string | null;
        allowed_model_aliases: string;
        note: string | null;
      }>(
        `SELECT id, username, email, role, group_id, enabled, group_locked, rpm, qps, tpm,
                quota_tokens, quota_requests,
                period_cycles,
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

  const nextGroupId = parsed.data.group_id === undefined ? existing.group_id : parsed.data.group_id;
  const nextPeriodCycles = cycleValidation.cycles !== undefined && modelGateFeatures.periodQuota
    ? serializePeriodCycleState(resolveUserPeriodCycles(
      cycleValidation.cycles,
      parsePeriodCycles(existing.period_cycles),
      parsePeriodCycles((await getUserGroup(nextGroupId))?.period_cycles),
    )) || null
    : existing.period_cycles;

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
    // 周期配额只走 period_cycles：旧单档列（quota_period / period_quota_*）已停止写入，
    // 仅保留在库里供回滚参考。
    // 提交契约：字段缺省/null 表示不动（继承当前配置）、空数组表示清空自有档、
    // 档位内额度为 null 表示继承组档、-1 表示显式不限制并覆盖组档。
    // 组没有可继承的档位时，提交的白值档位一律落成 -1，否则「继承空」等于没配置。
    period_cycles: nextPeriodCycles,
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
    group_locked:
      parsed.data.group_locked === undefined
        ? existing.group_locked
        : parsed.data.group_locked
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
         SET username = ?, email = ?, role = ?, group_id = ?, enabled = ?, group_locked = ?, rpm = ?, qps = ?, tpm = ?,
             quota_tokens = ?, quota_requests = ?,
             period_cycles = ?,
             allowed_model_aliases = ?, note = ?, password_hash = ?,
             token_version = COALESCE(token_version, 0) + 1
         WHERE id = ?`,
        [
          merged.username,
          merged.email,
          merged.role,
          merged.group_id,
          merged.enabled,
          merged.group_locked,
          merged.rpm,
          merged.qps,
          merged.tpm,
          merged.quota_tokens,
          merged.quota_requests,
          merged.period_cycles,
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
         SET username = ?, email = ?, role = ?, group_id = ?, enabled = ?, group_locked = ?, rpm = ?, qps = ?, tpm = ?,
             quota_tokens = ?, quota_requests = ?,
             period_cycles = ?,
             allowed_model_aliases = ?, note = ?
         WHERE id = ?`,
        [
          merged.username,
          merged.email,
          merged.role,
          merged.group_id,
          merged.enabled,
          merged.group_locked,
          merged.rpm,
          merged.qps,
          merged.tpm,
          merged.quota_tokens,
          merged.quota_requests,
          merged.period_cycles,
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
    // 周期用量只存在于档位计数器里（旧标量列已停写），因此这里只清档位计数。
    const cycleRow = await gatewayDb
      .queryOne<{ period_cycles: string | null; group_period_cycles: string | null }>(
        "SELECT period_cycles, group_period_cycles FROM users WHERE id = ?",
        [id],
      );
    const currentCycles = parsePeriodCycles(cycleRow?.period_cycles);
    if (currentCycles.length > 0) {
      const resetCycles = currentCycles.map((cycle) => ({
        ...cycle,
        used_tokens: 0,
        used_requests: 0,
        reset_at: null,
      }));
      await gatewayDb
        .execute("UPDATE users SET period_cycles = ? WHERE id = ?", [serializePeriodCycleState(resetCycles), id]);
    }
    // 继承自用户组的档位计数单独存放，同样需要清零，否则「重置用量」后用户仍被组档拦住。
    const inheritedCycles = parsePeriodCycles(cycleRow?.group_period_cycles);
    if (inheritedCycles.length > 0) {
      const resetInherited = inheritedCycles.map((cycle) => ({
        ...cycle,
        used_tokens: 0,
        used_requests: 0,
        reset_at: null,
      }));
      await gatewayDb
        .execute("UPDATE users SET group_period_cycles = ? WHERE id = ?", [serializePeriodCycleState(resetInherited), id]);
    }
  }

  const row = (await gatewayDb
    .queryOne<EffectiveLimitsInput & {
      id: number;
      allowed_model_aliases: string;
      group_name: string | null;
      group_period_cycles: string | null;
    }>(
      `SELECT u.id, u.username, u.email, u.role, u.group_id, g.name AS group_name,
              u.rpm, u.qps, u.tpm, u.quota_tokens, u.quota_requests,
              u.period_cycles, g.period_cycles AS group_period_cycles,
              u.used_tokens, u.used_requests, u.allowed_model_aliases, u.note, u.oidc_issuer, u.oidc_subject, u.group_locked,
              u.pref_model_fallback, u.pref_vision_fallback, u.pref_quota_fallback,
              u.enabled, u.created_at
       FROM users u
       LEFT JOIN \`groups\` g ON g.id = u.group_id AND g.enabled = 1 AND g.deleted_at IS NULL
       WHERE u.id = ? AND u.deleted_at IS NULL`,
      [id],
    ))!;

  // 与列表接口同口径回传生效档位，避免更新与查询两个响应的契约不一致。
  // 这里在重置用量的分支之后重新查库，因此重置后返回的是归零状态，而不是重置前的旧值。
  const effective = await getEffectiveLimits(row);
  const periods = await resolveEffectivePeriods(row.id, effective.period_cycles, row.period_cycles);

  return jsonOk({
    message: parsed.data.reset_usage ? "用量已重置。" : "用户更新成功。",
    data: { ...row, allowed_model_aliases: parseAllowedModelAliases(row.allowed_model_aliases), periods },
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

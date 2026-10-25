export const dynamic = "force-dynamic";

import { z } from "zod";
import { hashPassword } from "@/lib/auth/auth";
import { gatewayDb } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { getEffectiveLimits, getUserGroup, type EffectiveLimitsInput } from "@/lib/gateway/effective-limits";
import { modelGateFeatures } from "@/lib/core/features";
import { resolveEffectivePeriods } from "@/lib/gateway/quota";
import { listExistingModelAliases, parseAllowedModelAliases, stringifyAllowedModelAliases } from "@/lib/gateway/model-access";
import { USERNAME_SCHEMA } from "@/lib/auth/username";
import { friendlyCredentialPayloadError, passwordSchema } from "@/lib/auth/validation";
import { readJsonBodyCapped } from "@/lib/core/request-body";
import { parseInheritGroupPeriods, parsePeriodCycles, resolveUserPeriodCycles, serializePeriodCycleState, validatePeriodCycles } from "@/lib/gateway/period-cycles";

const createSchema = z.object({
  username: USERNAME_SCHEMA,
  password: passwordSchema(),
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
  inherit_group_periods: z.boolean().optional(),
  allowed_model_aliases: z.array(z.string().min(1)).optional(),
  note: z.string().max(500).nullable().optional(),
  group_locked: z.boolean().optional(),
});

function normalizeQuota(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  if (value < 0) return -1;
  return value;
}

function escapeLike(input: string): string {
  return input.replace(/\|/g, "||").replace(/%/g, "|%").replace(/_/g, "|_");
}

const USER_SORT_COLUMNS = {
  created_at: "u.id",
  used_requests: "u.used_requests",
  used_tokens: "u.used_tokens",
  username: "u.username",
} as const;

export async function GET(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  const keyword = (url.searchParams.get("keyword") ?? "").trim();
  const groupParam = (url.searchParams.get("group_id") ?? "").trim();
  const roleParam = (url.searchParams.get("role") ?? "").trim();
  const sortBy = (url.searchParams.get("sort_by") ?? "created_at").trim() as keyof typeof USER_SORT_COLUMNS;
  const sortDir = (url.searchParams.get("sort_dir") ?? "desc").trim().toLowerCase() === "asc" ? "ASC" : "DESC";
  const orderColumn = USER_SORT_COLUMNS[sortBy] ?? USER_SORT_COLUMNS.created_at;

  let groupFilterId: number | null = null;
  if (groupParam !== "" && groupParam !== "all") {
    const groupId = Number(groupParam);
    if (Number.isFinite(groupId) && groupId > 0) {
      groupFilterId = groupId;
    }
  }

  const whereParts = ["u.deleted_at IS NULL"];
  const whereArgs: Array<string | number> = [];
  if (keyword) {
    whereParts.push("(u.username LIKE ? ESCAPE '|' OR u.oidc_subject LIKE ? ESCAPE '|')");
    const pattern = `%${escapeLike(keyword)}%`;
    whereArgs.push(pattern, pattern);
  }
  if (groupFilterId !== null) {
    whereParts.push("u.group_id = ?");
    whereArgs.push(groupFilterId);
  }
  if (roleParam === "admin" || roleParam === "user") {
    whereParts.push("u.role = ?");
    whereArgs.push(roleParam);
  }
  const whereSql = `WHERE ${whereParts.join(" AND ")}`;

  // period_cycles 必须一起查出来：前端编辑弹窗用它回填档位，缺了它弹窗会显示为空，
  // 保存时提交空数组就会把用户已有的周期档清空。
  // 旧单档列（quota_period / period_quota_* / period_used_* / period_reset_at）已停止写入与读取，
  // 不再查询，避免把冻结的历史值混进响应。
  const rows = await gatewayDb
    .query<EffectiveLimitsInput & {
      id: number;
      username: string;
      email: string | null;
      role: "admin" | "user";
      used_tokens: number;
      used_requests: number;
      allowed_model_aliases: string;
      note: string | null;
      oidc_issuer: string | null;
      oidc_subject: string | null;
      group_locked: number;
      inherit_group_periods: number | null;
      pref_model_fallback: number;
      pref_vision_fallback: number;
      pref_quota_fallback: number;
      enabled: number;
      created_at: string;
      group_name: string | null;
    }>(
      `SELECT u.id, u.username, u.email, u.role, u.group_id, g.name AS group_name,
              u.rpm, u.qps, u.tpm, u.quota_tokens, u.quota_requests,
              u.period_cycles, u.inherit_group_periods,
              u.used_tokens, u.used_requests, u.allowed_model_aliases, u.note, u.oidc_issuer, u.oidc_subject, u.group_locked,
              u.pref_model_fallback, u.pref_vision_fallback, u.pref_quota_fallback,
              u.enabled, u.created_at
       FROM users u
       LEFT JOIN \`groups\` g ON g.id = u.group_id AND g.deleted_at IS NULL
       ${whereSql}
       ORDER BY ${orderColumn} ${sortDir}, u.id DESC
       LIMIT ? OFFSET ?`,
      [...whereArgs, limit, offset],
    );

  const totalWhereParts = ["deleted_at IS NULL"];
  const totalWhereArgs: Array<string | number> = [];
  if (keyword) {
    totalWhereParts.push("(username LIKE ? ESCAPE '|' OR oidc_subject LIKE ? ESCAPE '|')");
    const pattern = `%${escapeLike(keyword)}%`;
    totalWhereArgs.push(pattern, pattern);
  }
  if (groupFilterId !== null) {
    totalWhereParts.push("group_id = ?");
    totalWhereArgs.push(groupFilterId);
  }
  if (roleParam === "admin" || roleParam === "user") {
    totalWhereParts.push("role = ?");
    totalWhereArgs.push(roleParam);
  }
  const total = (await gatewayDb
    .queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total
       FROM users
       WHERE ${totalWhereParts.join(" AND ")}`,
      totalWhereArgs,
    ))!;

  const data = [];
  for (const row of rows) {
    const group = await getUserGroup(row.group_id ?? null);
    const inheritGroup = parseInheritGroupPeriods(row.inherit_group_periods);
    const effective = await getEffectiveLimits(row);
    // 生效档位 = 自有档（计数在 period_cycles）+ 组档中未被自有档覆盖的部分（计数在 group_period_cycles），
    // 与 /api/user/quota 同口径：两处计数分开存放，必须分别推进窗口再合并。
    const periods = await resolveEffectivePeriods(row.id, effective.period_cycles, row.period_cycles);
    data.push({
      ...row,
      allowed_model_aliases: parseAllowedModelAliases(row.allowed_model_aliases),
      group_rpm: group?.rpm ?? null,
      group_qps: group?.qps ?? null,
      group_tpm: group?.tpm ?? null,
      group_quota_requests: group?.quota_requests ?? null,
      group_quota_tokens: group?.quota_tokens ?? null,
      // 关掉继承时组档对用户不可见，回传 null 以免前端把组档当成「正在继承」展示。
      group_period_cycles: inheritGroup ? (group?.period_cycles ?? null) : null,
      inherit_group_periods: inheritGroup,
      effective_rpm: effective.rpm,
      effective_qps: effective.qps,
      effective_tpm: effective.tpm,
      effective_quota_requests: effective.quota_requests,
      effective_quota_tokens: effective.quota_tokens,
      periods,
    });
  }

  return jsonOk({
    data,
    paging: { limit, offset, total: total.total ?? 0 },
    sorting: {
      sort_by: sortBy in USER_SORT_COLUMNS ? sortBy : "created_at",
      sort_dir: sortDir.toLowerCase(),
    },
  });
}

export async function POST(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await readJsonBodyCapped(request);
  if (!body.ok) return jsonError("请求体过大", 413);
  const parsed = createSchema.safeParse(body.data);
  if (!parsed.success) return jsonError(friendlyCredentialPayloadError(parsed.error), 400);

  const existing = await gatewayDb
    .queryOne<{ id: number }>("SELECT id FROM users WHERE username = ?", [parsed.data.username]);
  if (existing) return jsonError("用户名已存在", 409);

  const cycleValidation = validatePeriodCycles(parsed.data.period_cycles);
  if (!cycleValidation.valid) return jsonError(cycleValidation.error, 400);
  if (cycleValidation.cycles === undefined && parsed.data.period_cycles !== undefined) {
    return jsonError("重置周期未提交任何档位，如需清空请传空数组。", 400);
  }

  let groupId = parsed.data.group_id ?? null;
  if (groupId === null) {
    const defaultGroup = await gatewayDb
      .queryOne<{ id: number }>("SELECT id FROM `groups` WHERE is_default = 1 AND deleted_at IS NULL");
    groupId = defaultGroup?.id ?? null;
  } else {
    const group = await gatewayDb
      .queryOne<{ id: number }>("SELECT id FROM `groups` WHERE id = ? AND deleted_at IS NULL", [groupId]);
    if (!group) return jsonError("用户组不存在", 400);
  }

  // 新建用户没有「原值」可继承：提交的档位原样落库，某一侧留空就表示跟着组档走
  // （读取时让位给组档），组里没有该周期时才落成 -1。与编辑接口同一口径。
  const inheritGroup = parsed.data.inherit_group_periods ?? true;
  const groupCycles = parsePeriodCycles((await getUserGroup(groupId))?.period_cycles);
  const periodCycles = modelGateFeatures.periodQuota
    ? serializePeriodCycleState(
      resolveUserPeriodCycles(cycleValidation.cycles ?? [], [], groupCycles, inheritGroup),
    ) || null
    : null;

  const passwordHash = await hashPassword(parsed.data.password);
  const inputAliases = parsed.data.allowed_model_aliases ?? [];
  const existingAliases = await listExistingModelAliases(inputAliases);
  const droppedAliases = inputAliases.filter((a) => !existingAliases.includes(a));

  const result = await gatewayDb
    .execute(
      `INSERT INTO users (
         username, password_hash, email, role, group_id, enabled, group_locked,
         rpm, qps, tpm, quota_tokens, quota_requests,
         period_cycles, inherit_group_periods,
         allowed_model_aliases, note
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parsed.data.username,
        passwordHash,
        parsed.data.email?.trim() || null,
        parsed.data.role ?? "user",
        groupId,
        parsed.data.enabled === false ? 0 : 1,
        parsed.data.group_locked === true ? 1 : 0,
        parsed.data.rpm ?? -1,
        parsed.data.qps ?? -1,
        parsed.data.tpm ?? -1,
        normalizeQuota(parsed.data.quota_tokens),
        normalizeQuota(parsed.data.quota_requests),
        periodCycles,
        inheritGroup ? 1 : 0,
        stringifyAllowedModelAliases(existingAliases),
        parsed.data.note?.trim() ? parsed.data.note.trim() : null,
      ],
    );

  const row = (await gatewayDb
    .queryOne<EffectiveLimitsInput & {
      id: number;
      allowed_model_aliases: string;
      group_name: string | null;
      group_period_cycles: string | null;
    }>(
      `SELECT u.id, u.username, u.email, u.role, u.group_id, g.name AS group_name,
              u.rpm, u.qps, u.tpm, u.quota_tokens, u.quota_requests,
              u.period_cycles, u.inherit_group_periods, g.period_cycles AS group_period_cycles,
              u.used_tokens, u.used_requests, u.allowed_model_aliases, u.note, u.oidc_issuer, u.oidc_subject, u.group_locked,
              u.pref_model_fallback, u.pref_vision_fallback, u.pref_quota_fallback,
              u.enabled, u.created_at
       FROM users u
       LEFT JOIN \`groups\` g ON g.id = u.group_id AND g.enabled = 1 AND g.deleted_at IS NULL
       WHERE u.id = ? AND u.deleted_at IS NULL`,
      [result.lastInsertRowid],
    ))!;

  // 与列表接口同口径回传生效档位，避免创建与查询两个响应的契约不一致。
  const effective = await getEffectiveLimits(row);
  const periods = await resolveEffectivePeriods(row.id, effective.period_cycles, row.period_cycles);

  return jsonOk({
    message: "用户创建成功。",
    data: { ...row, allowed_model_aliases: parseAllowedModelAliases(row.allowed_model_aliases), periods },
    ...(droppedAliases.length > 0 ? { warnings: [`以下模型别名不存在，已忽略: ${droppedAliases.join(", ")}`] } : {}),
  }, 201);
}

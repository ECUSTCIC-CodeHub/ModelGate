export const dynamic = "force-dynamic";

import { z } from "zod";
import { hashPassword } from "@/lib/auth/auth";
import { gatewayDb, type DbUser } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { getEffectiveLimits, getUserGroup } from "@/lib/gateway/effective-limits";
import { modelGateFeatures } from "@/lib/core/features";
import { parseAllowedModelAliases, stringifyAllowedModelAliases } from "@/lib/gateway/model-access";
import { USERNAME_SCHEMA } from "@/lib/auth/username";
import { friendlyCredentialPayloadError } from "@/lib/auth/validation";

const createSchema = z.object({
  username: USERNAME_SCHEMA,
  password: z.string().min(8),
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
});

function normalizeQuota(value: number | null | undefined) {
  if (value === null || value === undefined || value < 0) return null;
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
    whereParts.push("u.username LIKE ? ESCAPE '|'");
    whereArgs.push(`%${escapeLike(keyword)}%`);
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

  const rows = await gatewayDb
    .query<DbUser & { group_name: string | null; allowed_model_aliases: string }>(
      `SELECT u.id, u.username, u.email, u.role, u.group_id, g.name AS group_name,
              u.rpm, u.qps, u.tpm, u.quota_tokens, u.quota_requests,
              u.quota_period, u.period_quota_tokens, u.period_quota_requests,
              u.period_used_tokens, u.period_used_requests, u.period_reset_at,
              u.used_tokens, u.used_requests, u.allowed_model_aliases, u.note, u.oidc_issuer, u.oidc_subject, u.totp_enabled, u.enabled, u.created_at
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
    totalWhereParts.push("username LIKE ? ESCAPE '|'");
    totalWhereArgs.push(`%${escapeLike(keyword)}%`);
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
    const effective = await getEffectiveLimits(row);
    data.push({
      ...row,
      allowed_model_aliases: parseAllowedModelAliases(row.allowed_model_aliases),
      group_rpm: group?.rpm ?? null,
      group_qps: group?.qps ?? null,
      group_tpm: group?.tpm ?? null,
      group_quota_requests: group?.quota_requests ?? null,
      group_quota_tokens: group?.quota_tokens ?? null,
      group_quota_period: group?.quota_period ?? null,
      group_period_quota_tokens: group?.period_quota_tokens ?? null,
      group_period_quota_requests: group?.period_quota_requests ?? null,
      effective_rpm: effective.rpm,
      effective_qps: effective.qps,
      effective_tpm: effective.tpm,
      effective_quota_requests: effective.quota_requests,
      effective_quota_tokens: effective.quota_tokens,
      effective_quota_period: effective.quota_period,
      effective_period_quota_tokens: effective.period_quota_tokens,
      effective_period_quota_requests: effective.period_quota_requests,
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

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return jsonError(friendlyCredentialPayloadError(parsed.error), 400);

  const existing = await gatewayDb
    .queryOne<{ id: number }>("SELECT id FROM users WHERE username = ?", [parsed.data.username]);
  if (existing) return jsonError("用户名已存在", 409);

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

  const passwordHash = await hashPassword(parsed.data.password);
  const result = await gatewayDb
    .execute(
      `INSERT INTO users (
         username, password_hash, email, role, group_id, enabled,
         rpm, qps, tpm, quota_tokens, quota_requests,
         quota_period, period_quota_tokens, period_quota_requests,
         allowed_model_aliases, note
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parsed.data.username,
        passwordHash,
        parsed.data.email?.trim() || null,
        parsed.data.role ?? "user",
        groupId,
        parsed.data.enabled === false ? 0 : 1,
        parsed.data.rpm ?? -1,
        parsed.data.qps ?? -1,
        parsed.data.tpm ?? -1,
        normalizeQuota(parsed.data.quota_tokens),
        normalizeQuota(parsed.data.quota_requests),
        modelGateFeatures.periodQuota ? normalizeQuota(parsed.data.quota_period) : null,
        modelGateFeatures.periodQuota ? normalizeQuota(parsed.data.period_quota_tokens) : null,
        modelGateFeatures.periodQuota ? normalizeQuota(parsed.data.period_quota_requests) : null,
        stringifyAllowedModelAliases(parsed.data.allowed_model_aliases ?? []),
        parsed.data.note?.trim() ? parsed.data.note.trim() : null,
      ],
    );

  const row = (await gatewayDb
    .queryOne<{ allowed_model_aliases: string } & Record<string, unknown>>(
      `SELECT u.id, u.username, u.email, u.role, u.group_id, g.name AS group_name,
              u.rpm, u.qps, u.tpm, u.quota_tokens, u.quota_requests,
              u.quota_period, u.period_quota_tokens, u.period_quota_requests,
              u.period_used_tokens, u.period_used_requests, u.period_reset_at,
              u.used_tokens, u.used_requests, u.allowed_model_aliases, u.note, u.oidc_issuer, u.oidc_subject, u.totp_enabled, u.enabled, u.created_at
       FROM users u
       LEFT JOIN \`groups\` g ON g.id = u.group_id AND g.deleted_at IS NULL
       WHERE u.id = ? AND u.deleted_at IS NULL`,
      [result.lastInsertRowid],
    ))!;

  return jsonOk({
    message: "用户创建成功。",
    data: { ...row, allowed_model_aliases: parseAllowedModelAliases(row.allowed_model_aliases) },
  }, 201);
}

export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/core/db";
import { validateClaimExpr } from "@/lib/shared/claim-expr";
import { modelGateFeatures } from "@/lib/core/features";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { parseAllowedModelAliases, stringifyAllowedModelAliases } from "@/lib/gateway/model-access";

const createSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(200).nullable().optional(),
  qps: z.number().int().min(-1).optional(),
  rpm: z.number().int().min(-1).optional(),
  tpm: z.number().int().min(-1).optional(),
  quota_requests: z.number().int().min(-1).nullable().optional(),
  quota_tokens: z.number().int().min(-1).nullable().optional(),
  quota_period: z.number().int().min(0).nullable().optional(),
  period_quota_tokens: z.number().int().min(-1).nullable().optional(),
  period_quota_requests: z.number().int().min(-1).nullable().optional(),
  allowed_model_aliases: z.array(z.string().min(1)).optional(),
  oidc_claim_expr: z.string().max(512).nullable().optional(),
  oidc_claim_priority: z.number().int().min(0).max(9999).optional(),
  is_default: z.boolean().optional(),
});

function normalizeQuota(value: number | null | undefined) {
  if (value === null || value === undefined || value < 0) return null;
  return value;
}

export async function GET(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

  const rows = gatewayDb
    .prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.group_id = g.id AND u.deleted_at IS NULL) AS user_count
       FROM groups g
       WHERE g.deleted_at IS NULL
       ORDER BY g.is_default DESC, g.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as Array<Record<string, unknown> & { allowed_model_aliases: string }>;

  const total = gatewayDb
    .prepare("SELECT COUNT(*) AS total FROM groups WHERE deleted_at IS NULL")
    .get() as { total: number };

  return jsonOk({
    data: rows.map((row) => ({
      ...row,
      allowed_model_aliases: parseAllowedModelAliases(row.allowed_model_aliases),
    })),
    paging: { limit, offset, total: total.total ?? 0 },
  });
}

export async function POST(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const exprTrimmed = modelGateFeatures.oidc ? parsed.data.oidc_claim_expr?.trim() || null : null;
  if (exprTrimmed) {
    const result = validateClaimExpr(exprTrimmed);
    if (!result.valid) return jsonError(`Claim 表达式语法错误: ${result.error}`, 400);
  }

  const existing = gatewayDb
    .prepare("SELECT id FROM groups WHERE name = ? AND deleted_at IS NULL")
    .get(parsed.data.name) as { id: number } | undefined;
  if (existing) return jsonError("组名已存在", 409);

  const setDefault = parsed.data.is_default === true;

  const tx = gatewayDb.transaction(() => {
    if (setDefault) {
      gatewayDb.prepare("UPDATE groups SET is_default = 0 WHERE is_default = 1").run();
    }

    return gatewayDb
      .prepare(
        `INSERT INTO groups (name, description, qps, rpm, tpm, quota_requests, quota_tokens, quota_period, period_quota_tokens, period_quota_requests, allowed_model_aliases, oidc_claim_expr, oidc_claim_priority, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.data.name,
        parsed.data.description?.trim() || null,
        parsed.data.qps ?? -1,
        parsed.data.rpm ?? -1,
        parsed.data.tpm ?? -1,
        normalizeQuota(parsed.data.quota_requests),
        normalizeQuota(parsed.data.quota_tokens),
        modelGateFeatures.periodQuota ? normalizeQuota(parsed.data.quota_period) : null,
        modelGateFeatures.periodQuota ? normalizeQuota(parsed.data.period_quota_tokens) : null,
        modelGateFeatures.periodQuota ? normalizeQuota(parsed.data.period_quota_requests) : null,
        stringifyAllowedModelAliases(parsed.data.allowed_model_aliases ?? []),
        exprTrimmed,
        modelGateFeatures.oidc ? parsed.data.oidc_claim_priority ?? 0 : 0,
        setDefault ? 1 : 0,
      );
  });

  const result = tx();

  const row = gatewayDb
    .prepare("SELECT * FROM groups WHERE id = ?")
    .get(result.lastInsertRowid) as Record<string, unknown> & { allowed_model_aliases: string };

  return jsonOk(
    {
      message: "用户组创建成功。",
      data: { ...row, allowed_model_aliases: parseAllowedModelAliases(row.allowed_model_aliases), user_count: 0 },
    },
    201,
  );
}

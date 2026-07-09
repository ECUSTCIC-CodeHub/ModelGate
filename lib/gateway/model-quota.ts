import { gatewayDb } from "@/lib/core/db";
import { modelGateFeatures } from "@/lib/core/features";
import { toMysqlDatetime } from "@/lib/core/db/datetime";

export type ModelQuotaInfo = {
  remaining_requests: number | null;
  remaining_tokens: number | null;
  period_remaining_requests: number | null;
  period_remaining_tokens: number | null;
  period_reset_at: string | null;
};

async function ensureModelPeriodReset(modelId: number, period: number, resetAt: string | null): Promise<{ period_used_tokens: number; period_used_requests: number; period_reset_at: string }> {
  const now = new Date();
  if (resetAt && new Date(resetAt) > now) {
    return gatewayDb.queryOne(
      "SELECT period_used_tokens, period_used_requests, period_reset_at FROM models WHERE id = ?",
      [modelId],
    ) as Promise<{ period_used_tokens: number; period_used_requests: number; period_reset_at: string }>;
  }
  const nextReset = new Date(now.getTime() + period * 1000);
  const result = await gatewayDb.execute(
    `UPDATE models
       SET period_used_tokens = 0, period_used_requests = 0, period_reset_at = ?
       WHERE id = ? AND (period_reset_at IS NULL OR period_reset_at <= ?)`,
    [toMysqlDatetime(nextReset), modelId, toMysqlDatetime(now)],
  );
  if (result.changes > 0) {
    return { period_used_tokens: 0, period_used_requests: 0, period_reset_at: toMysqlDatetime(nextReset) };
  }
  return gatewayDb.queryOne(
    "SELECT period_used_tokens, period_used_requests, period_reset_at FROM models WHERE id = ?",
    [modelId],
  ) as Promise<{ period_used_tokens: number; period_used_requests: number; period_reset_at: string }>;
}

export async function checkModelQuota(modelId: number, estimatedTokens: number): Promise<{ ok: false; reason: string } | { ok: true; quota: ModelQuotaInfo }> {
  const model = await gatewayDb.queryOne<{
    id: number;
    quota_tokens: number | null;
    quota_requests: number | null;
    quota_period: number | null;
    period_quota_tokens: number | null;
    period_quota_requests: number | null;
    period_used_tokens: number;
    period_used_requests: number;
    period_reset_at: string | null;
  }>(
    `SELECT id, quota_tokens, quota_requests, quota_period,
              period_quota_tokens, period_quota_requests,
              period_used_tokens, period_used_requests, period_reset_at
              FROM models WHERE id = ? AND deleted_at IS NULL`,
    [modelId],
  );

  if (!model) {
    return { ok: false, reason: "模型不存在" };
  }

  const quota: ModelQuotaInfo = {
    remaining_requests: model.quota_requests !== null ? Math.max(0, model.quota_requests - model.period_used_requests) : null,
    remaining_tokens: model.quota_tokens !== null ? Math.max(0, model.quota_tokens - model.period_used_tokens) : null,
    period_remaining_requests: null,
    period_remaining_tokens: null,
    period_reset_at: null,
  };

  if (model.quota_requests !== null && model.period_used_requests >= model.quota_requests) {
    return { ok: false, reason: "模型请求配额已用尽" };
  }

  if (model.quota_tokens !== null && model.period_used_tokens + estimatedTokens > model.quota_tokens) {
    return { ok: false, reason: "模型 Token 配额已用尽" };
  }

  if (modelGateFeatures.periodQuota && model.quota_period) {
    const period = await ensureModelPeriodReset(modelId, model.quota_period, model.period_reset_at);
    quota.period_reset_at = period.period_reset_at;

    if (model.period_quota_requests !== null) {
      quota.period_remaining_requests = Math.max(0, model.period_quota_requests - period.period_used_requests);
      if (period.period_used_requests >= model.period_quota_requests) {
        return { ok: false, reason: "模型周期请求配额已用尽" };
      }
    }

    if (model.period_quota_tokens !== null) {
      quota.period_remaining_tokens = Math.max(0, model.period_quota_tokens - period.period_used_tokens);
      if (period.period_used_tokens + estimatedTokens > model.period_quota_tokens) {
        return { ok: false, reason: "模型周期 Token 配额已用尽" };
      }
    }
  }

  return { ok: true, quota };
}

export function appendModelQuotaHeaders(headers: Record<string, string>, quota: ModelQuotaInfo) {
  if (quota.remaining_requests !== null) {
    headers["X-Model-Quota-Requests-Remaining"] = String(quota.remaining_requests);
  }
  if (quota.remaining_tokens !== null) {
    headers["X-Model-Quota-Tokens-Remaining"] = String(quota.remaining_tokens);
  }
  if (quota.period_remaining_requests !== null) {
    headers["X-Model-Period-Quota-Requests-Remaining"] = String(quota.period_remaining_requests);
  }
  if (quota.period_remaining_tokens !== null) {
    headers["X-Model-Period-Quota-Tokens-Remaining"] = String(quota.period_remaining_tokens);
  }
  if (quota.period_reset_at) {
    headers["X-Model-Period-Quota-Reset"] = quota.period_reset_at;
  }
}

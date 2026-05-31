import { gatewayDb } from "@/lib/core/db";
import { modelGateFeatures } from "@/lib/core/features";

export type ModelQuotaInfo = {
  remaining_requests: number | null;
  remaining_tokens: number | null;
  period_remaining_requests: number | null;
  period_remaining_tokens: number | null;
  period_reset_at: string | null;
  per_user_remaining_requests: number | null;
  per_user_remaining_tokens: number | null;
  per_user_period_remaining_requests: number | null;
  per_user_period_remaining_tokens: number | null;
  per_user_period_reset_at: string | null;
};

function ensureModelPeriodReset(modelId: number, period: number, resetAt: string | null): { period_used_tokens: number; period_used_requests: number; period_reset_at: string } {
  const now = new Date();
  if (resetAt && new Date(resetAt) > now) {
    return gatewayDb
      .prepare("SELECT period_used_tokens, period_used_requests, period_reset_at FROM models WHERE id = ?")
      .get(modelId) as { period_used_tokens: number; period_used_requests: number; period_reset_at: string };
  }
  const nextReset = new Date(now.getTime() + period * 1000).toISOString();
  const result = gatewayDb
    .prepare(
      `UPDATE models
       SET period_used_tokens = 0, period_used_requests = 0, period_reset_at = ?
       WHERE id = ? AND (period_reset_at IS NULL OR period_reset_at <= ?)`,
    )
    .run(nextReset, modelId, now.toISOString());
  if (result.changes > 0) {
    return { period_used_tokens: 0, period_used_requests: 0, period_reset_at: nextReset };
  }
  return gatewayDb
    .prepare("SELECT period_used_tokens, period_used_requests, period_reset_at FROM models WHERE id = ?")
    .get(modelId) as { period_used_tokens: number; period_used_requests: number; period_reset_at: string };
}

function ensureModelUserPeriodReset(modelId: number, userId: number, period: number, resetAt: string | null): { period_used_tokens: number; period_used_requests: number; period_reset_at: string } {
  const now = new Date();
  if (resetAt && new Date(resetAt) > now) {
    return gatewayDb
      .prepare("SELECT period_used_tokens, period_used_requests, period_reset_at FROM model_user_usage WHERE model_id = ? AND user_id = ?")
      .get(modelId, userId) as { period_used_tokens: number; period_used_requests: number; period_reset_at: string };
  }
  const nextReset = new Date(now.getTime() + period * 1000).toISOString();
  const result = gatewayDb
    .prepare(
      `UPDATE model_user_usage
       SET period_used_tokens = 0, period_used_requests = 0, period_reset_at = ?
       WHERE model_id = ? AND user_id = ? AND (period_reset_at IS NULL OR period_reset_at <= ?)`,
    )
    .run(nextReset, modelId, userId, now.toISOString());
  if (result.changes > 0) {
    return { period_used_tokens: 0, period_used_requests: 0, period_reset_at: nextReset };
  }
  return gatewayDb
    .prepare("SELECT period_used_tokens, period_used_requests, period_reset_at FROM model_user_usage WHERE model_id = ? AND user_id = ?")
    .get(modelId, userId) as { period_used_tokens: number; period_used_requests: number; period_reset_at: string };
}

function getOrCreateModelUserUsage(modelId: number, userId: number) {
  const existing = gatewayDb
    .prepare("SELECT used_tokens, used_requests, period_used_tokens, period_used_requests, period_reset_at FROM model_user_usage WHERE model_id = ? AND user_id = ?")
    .get(modelId, userId) as
    | { used_tokens: number; used_requests: number; period_used_tokens: number; period_used_requests: number; period_reset_at: string | null }
    | undefined;
  if (existing) return existing;
  gatewayDb
    .prepare("INSERT INTO model_user_usage (model_id, user_id, used_tokens, used_requests, period_used_tokens, period_used_requests) VALUES (?, ?, 0, 0, 0, 0)")
    .run(modelId, userId);
  return { used_tokens: 0, used_requests: 0, period_used_tokens: 0, period_used_requests: 0, period_reset_at: null };
}

export function checkModelQuota(modelId: number, estimatedTokens: number, userId?: number): { ok: false; reason: string } | { ok: true; quota: ModelQuotaInfo } {
  const model = gatewayDb
    .prepare(`SELECT id, quota_tokens, quota_requests, quota_period,
              period_quota_tokens, period_quota_requests,
              period_used_tokens, period_used_requests, period_reset_at,
              per_user_quota_requests, per_user_quota_tokens,
              per_user_quota_period, per_user_period_quota_requests, per_user_period_quota_tokens
              FROM models WHERE id = ? AND deleted_at IS NULL`)
    .get(modelId) as
    | {
        id: number;
        quota_tokens: number | null;
        quota_requests: number | null;
        quota_period: number | null;
        period_quota_tokens: number | null;
        period_quota_requests: number | null;
        period_used_tokens: number;
        period_used_requests: number;
        period_reset_at: string | null;
        per_user_quota_requests: number | null;
        per_user_quota_tokens: number | null;
        per_user_quota_period: number | null;
        per_user_period_quota_requests: number | null;
        per_user_period_quota_tokens: number | null;
      }
    | undefined;

  if (!model) {
    return { ok: false, reason: "模型不存在" };
  }

  const quota: ModelQuotaInfo = {
    remaining_requests: model.quota_requests !== null ? Math.max(0, model.quota_requests - model.period_used_requests) : null,
    remaining_tokens: model.quota_tokens !== null ? Math.max(0, model.quota_tokens - model.period_used_tokens) : null,
    period_remaining_requests: null,
    period_remaining_tokens: null,
    period_reset_at: null,
    per_user_remaining_requests: null,
    per_user_remaining_tokens: null,
    per_user_period_remaining_requests: null,
    per_user_period_remaining_tokens: null,
    per_user_period_reset_at: null,
  };

  if (model.quota_requests !== null && model.period_used_requests >= model.quota_requests) {
    return { ok: false, reason: "模型请求配额已用尽" };
  }

  if (model.quota_tokens !== null && model.period_used_tokens + estimatedTokens > model.quota_tokens) {
    return { ok: false, reason: "模型 Token 配额已用尽" };
  }

  if (modelGateFeatures.periodQuota && model.quota_period) {
    const period = ensureModelPeriodReset(modelId, model.quota_period, model.period_reset_at);
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

  const hasPerUserLimits = model.per_user_quota_requests !== null
    || model.per_user_quota_tokens !== null
    || model.per_user_period_quota_requests !== null
    || model.per_user_period_quota_tokens !== null;

  if (hasPerUserLimits && userId != null) {
    const usage = getOrCreateModelUserUsage(modelId, userId);

    quota.per_user_remaining_requests = model.per_user_quota_requests !== null
      ? Math.max(0, model.per_user_quota_requests - usage.used_requests)
      : null;
    quota.per_user_remaining_tokens = model.per_user_quota_tokens !== null
      ? Math.max(0, model.per_user_quota_tokens - usage.used_tokens)
      : null;

    if (model.per_user_quota_requests !== null && usage.used_requests >= model.per_user_quota_requests) {
      return { ok: false, reason: "模型个人请求配额已用尽" };
    }

    if (model.per_user_quota_tokens !== null && usage.used_tokens + estimatedTokens > model.per_user_quota_tokens) {
      return { ok: false, reason: "模型个人 Token 配额已用尽" };
    }

    if (modelGateFeatures.periodQuota && model.per_user_quota_period) {
      const period = ensureModelUserPeriodReset(modelId, userId, model.per_user_quota_period, usage.period_reset_at);
      quota.per_user_period_reset_at = period.period_reset_at;

      if (model.per_user_period_quota_requests !== null) {
        quota.per_user_period_remaining_requests = Math.max(0, model.per_user_period_quota_requests - period.period_used_requests);
        if (period.period_used_requests >= model.per_user_period_quota_requests) {
          return { ok: false, reason: "模型个人周期请求配额已用尽" };
        }
      }

      if (model.per_user_period_quota_tokens !== null) {
        quota.per_user_period_remaining_tokens = Math.max(0, model.per_user_period_quota_tokens - period.period_used_tokens);
        if (period.period_used_tokens + estimatedTokens > model.per_user_period_quota_tokens) {
          return { ok: false, reason: "模型个人周期 Token 配额已用尽" };
        }
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
  if (quota.per_user_remaining_requests !== null) {
    headers["X-Model-Per-User-Quota-Requests-Remaining"] = String(quota.per_user_remaining_requests);
  }
  if (quota.per_user_remaining_tokens !== null) {
    headers["X-Model-Per-User-Quota-Tokens-Remaining"] = String(quota.per_user_remaining_tokens);
  }
  if (quota.per_user_period_remaining_requests !== null) {
    headers["X-Model-Per-User-Period-Quota-Requests-Remaining"] = String(quota.per_user_period_remaining_requests);
  }
  if (quota.per_user_period_remaining_tokens !== null) {
    headers["X-Model-Per-User-Period-Quota-Tokens-Remaining"] = String(quota.per_user_period_remaining_tokens);
  }
  if (quota.per_user_period_reset_at) {
    headers["X-Model-Per-User-Period-Quota-Reset"] = quota.per_user_period_reset_at;
  }
}

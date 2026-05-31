import { gatewayDb } from "@/lib/core/db";
import { modelGateFeatures } from "@/lib/core/features";

export function addUsage(userId: number, keyId: number, tokens: number, requests = 1, tokenMultiplier = 1, requestMultiplier = 1, channelId?: number, modelId?: number, quotaMode?: string) {
  const billedTokens = Math.max(0, tokens * tokenMultiplier);
  const billedRequests = Math.max(0, requests * requestMultiplier);
  const countUserUsage = quotaMode === "follow_group" || quotaMode == null;
  const isIndependent = quotaMode === "independent";
  const tx = gatewayDb.transaction(() => {
    if (countUserUsage) {
      if (modelGateFeatures.periodQuota) {
        gatewayDb
          .prepare(
            `UPDATE users
             SET used_tokens = used_tokens + ?, used_requests = used_requests + ?,
                 period_used_tokens = period_used_tokens + ?, period_used_requests = period_used_requests + ?
             WHERE id = ? AND deleted_at IS NULL`,
          )
          .run(billedTokens, billedRequests, billedTokens, billedRequests, userId);
      } else {
        gatewayDb
          .prepare(
            `UPDATE users
             SET used_tokens = used_tokens + ?, used_requests = used_requests + ?
             WHERE id = ? AND deleted_at IS NULL`,
          )
          .run(billedTokens, billedRequests, userId);
      }
    }

    gatewayDb
      .prepare(
        `UPDATE keys
         SET used_tokens = used_tokens + ?, used_requests = used_requests + ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(billedTokens, billedRequests, keyId);

    if (channelId != null && modelGateFeatures.periodQuota) {
      gatewayDb
        .prepare(
          `UPDATE channels
           SET period_used_tokens = period_used_tokens + ?, period_used_requests = period_used_requests + ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(billedTokens, billedRequests, channelId);
    }

    if (modelId != null && modelGateFeatures.periodQuota) {
      gatewayDb
        .prepare(
          `UPDATE models
           SET period_used_tokens = period_used_tokens + ?, period_used_requests = period_used_requests + ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(billedTokens, billedRequests, modelId);
    }

    if (isIndependent && modelId != null) {
      const hasPerUserLimits = gatewayDb
        .prepare(
          `SELECT per_user_quota_requests, per_user_quota_tokens,
                  per_user_quota_period, per_user_period_quota_requests, per_user_period_quota_tokens
           FROM models WHERE id = ? AND deleted_at IS NULL`,
        )
        .get(modelId) as
        | {
            per_user_quota_requests: number | null;
            per_user_quota_tokens: number | null;
            per_user_quota_period: number | null;
            per_user_period_quota_requests: number | null;
            per_user_period_quota_tokens: number | null;
          }
        | undefined;

      if (hasPerUserLimits && (
        hasPerUserLimits.per_user_quota_requests !== null
        || hasPerUserLimits.per_user_quota_tokens !== null
        || hasPerUserLimits.per_user_period_quota_requests !== null
        || hasPerUserLimits.per_user_period_quota_tokens !== null
      )) {
        gatewayDb
          .prepare(
            `INSERT INTO model_user_usage (model_id, user_id, used_tokens, used_requests, period_used_tokens, period_used_requests)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(model_id, user_id) DO UPDATE SET
               used_tokens = used_tokens + ?,
               used_requests = used_requests + ?,
               period_used_tokens = period_used_tokens + ?,
               period_used_requests = period_used_requests + ?`,
          )
          .run(modelId, userId, billedTokens, billedRequests, billedTokens, billedRequests,
            billedTokens, billedRequests, billedTokens, billedRequests);
      }
    }
  });
  tx();
}

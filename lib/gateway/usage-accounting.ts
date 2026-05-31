import { gatewayDb } from "@/lib/core/db";
import { modelGateFeatures } from "@/lib/core/features";

export function addUsage(userId: number, keyId: number, tokens: number, requests = 1, tokenMultiplier = 1, requestMultiplier = 1, channelId?: number, modelId?: number, quotaMode?: string) {
  const billedTokens = Math.max(0, tokens * tokenMultiplier);
  const billedRequests = Math.max(0, requests * requestMultiplier);
  const countUserUsage = quotaMode === "follow_group" || quotaMode == null;
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
  });
  tx();
}

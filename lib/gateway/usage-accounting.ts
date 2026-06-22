import { gatewayDb } from "@/lib/core/db";
import { modelGateFeatures } from "@/lib/core/features";

function cleanFloat(value: number): number {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 1e-6) return rounded;
  return Math.round(value * 1e6) / 1e6;
}

export async function addUsage(userId: number, keyId: number, tokens: number, requests = 1, tokenMultiplier = 1, requestMultiplier = 1, channelId?: number, modelId?: number) {
  const billedTokens = cleanFloat(Math.max(0, tokens * tokenMultiplier));
  const billedRequests = cleanFloat(Math.max(0, requests * requestMultiplier));
  await gatewayDb.transaction(async (tx) => {
    if (modelGateFeatures.periodQuota) {
      await tx.execute(
        `UPDATE users
           SET used_tokens = used_tokens + ?, used_requests = used_requests + ?,
               period_used_tokens = period_used_tokens + ?, period_used_requests = period_used_requests + ?
           WHERE id = ? AND deleted_at IS NULL`,
        [billedTokens, billedRequests, billedTokens, billedRequests, userId],
      );
    } else {
      await tx.execute(
        `UPDATE users
           SET used_tokens = used_tokens + ?, used_requests = used_requests + ?
           WHERE id = ? AND deleted_at IS NULL`,
        [billedTokens, billedRequests, userId],
      );
    }

    await tx.execute(
      `UPDATE \`keys\`
         SET used_tokens = used_tokens + ?, used_requests = used_requests + ?, last_used_at = CURRENT_TIMESTAMP
         WHERE id = ? AND deleted_at IS NULL`,
      [billedTokens, billedRequests, keyId],
    );

    if (channelId != null && modelGateFeatures.periodQuota) {
      await tx.execute(
        `UPDATE channels
           SET period_used_tokens = period_used_tokens + ?, period_used_requests = period_used_requests + ?
           WHERE id = ? AND deleted_at IS NULL`,
        [billedTokens, billedRequests, channelId],
      );
    }

    if (modelId != null && modelGateFeatures.periodQuota) {
      await tx.execute(
        `UPDATE models
           SET period_used_tokens = period_used_tokens + ?, period_used_requests = period_used_requests + ?
           WHERE id = ? AND deleted_at IS NULL`,
        [billedTokens, billedRequests, modelId],
      );
    }
  });
}

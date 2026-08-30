import { gatewayDb } from "@/lib/core/db";
import { modelGateFeatures } from "@/lib/core/features";
import { parseStoredUtc } from "@/lib/core/db/datetime";
import { parseAllowedChannelIds } from "@/lib/gateway/channel-access";
import { parseAllowedModelAliases } from "@/lib/gateway/model-access";

function cleanFloat(value: number): number {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 1e-6) return rounded;
  return Math.round(value * 1e6) / 1e6;
}

// 事务内查找匹配当前渠道+模型的用户有效定向额度。
async function findMatchingBalanceInTx(
  tx: TransactionContextLike,
  userId: number,
  channelId: number,
  modelAlias: string,
): Promise<{ id: number } | null> {
  const rows = await tx.query<{
    id: number;
    token_quota: number | null;
    request_quota: number | null;
    used_tokens: number;
    used_requests: number;
    allowed_channel_ids: string;
    allowed_model_aliases: string;
    expires_at: string | null;
  }>(
    `SELECT id, token_quota, request_quota, used_tokens, used_requests,
            allowed_channel_ids, allowed_model_aliases, expires_at
       FROM redeem_balances WHERE user_id = ?`,
    [userId],
  );

  for (const row of rows) {
    const remainingTokens = row.token_quota !== null ? row.token_quota - row.used_tokens : null;
    const remainingRequests = row.request_quota !== null ? row.request_quota - row.used_requests : null;
    if (remainingTokens !== null && remainingTokens <= 0) continue;
    if (remainingRequests !== null && remainingRequests <= 0) continue;
    if (row.expires_at) {
      const expires = parseStoredUtc(row.expires_at);
      if (expires && expires.getTime() <= Date.now()) continue;
    }
    const channelIds = parseAllowedChannelIds(row.allowed_channel_ids);
    const aliases = parseAllowedModelAliases(row.allowed_model_aliases);
    const channelMatch = channelIds.length === 0 || channelIds.includes(channelId);
    const aliasMatch = aliases.length === 0 || aliases.includes(modelAlias);
    if (channelMatch && aliasMatch) {
      return { id: row.id };
    }
  }
  return null;
}

type TransactionContextLike = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
};

export async function addUsage(userId: number, keyId: number, tokens: number, requests = 1, tokenMultiplier = 1, requestMultiplier = 1, channelId?: number, modelId?: number, modelAlias?: string | null) {
  const billedTokens = cleanFloat(Math.max(0, tokens * tokenMultiplier));
  const billedRequests = cleanFloat(Math.max(0, requests * requestMultiplier));

  await gatewayDb.transaction(async (tx) => {
    // 命中用户定向额度（兑换码）时，从定向额度中扣减，且不再计入用户全局用量。
    let coveredByRedeem = false;
    if (channelId != null && modelAlias && modelGateFeatures.redeemCode) {
      const balance = await findMatchingBalanceInTx(tx, userId, channelId, modelAlias);
      if (balance) {
        await tx.execute(
          `UPDATE redeem_balances
             SET used_tokens = used_tokens + ?, used_requests = used_requests + ?
             WHERE id = ?`,
          [billedTokens, billedRequests, balance.id],
        );
        coveredByRedeem = true;
      }
    }

    if (!coveredByRedeem) {
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

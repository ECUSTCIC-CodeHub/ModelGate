import { gatewayDb } from "@/lib/core/db";
import { toMysqlDatetime } from "@/lib/core/db/datetime";
import { getGatewaySettings } from "@/lib/core/settings";

function parseAliases(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseChannelIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => (typeof x === "number" ? x : Number(x)))
      .filter((x) => Number.isInteger(x) && x > 0);
  } catch {
    return [];
  }
}

// 用户有效定向额度中「明确限定」的模型别名与渠道 ID 并集，作为网关访问授权的额外来源。
// 语义：兑换即授权 —— 额度有效期内用户获得限定的渠道/模型访问权，额度用尽/过期/兑换码停用后自动回收。
// 空限定列表（不限制）不构成授权来源，避免把「计费不限制」误当「授权所有」。
export async function listRedeemCoveredAuthorization(userId: number): Promise<{ aliases: string[]; channelIds: number[] }> {
  // 功能关闭时授权来源一并失效，否则「关闭开关」只是藏了入口，已兑换用户仍拿着兑换码换来的渠道/模型权限。
  if (!(await getGatewaySettings()).runtime_features.redeemCode) {
    return { aliases: [], channelIds: [] };
  }

  const now = toMysqlDatetime(new Date());
  const rows = await gatewayDb.query<{ allowed_model_aliases: string | null; allowed_channel_ids: string | null }>(
    `SELECT b.allowed_model_aliases, b.allowed_channel_ids
       FROM redeem_balances b
       JOIN redeem_codes c ON c.id = b.code_id
       WHERE b.user_id = ?
         AND c.enabled = 1
         AND (b.expires_at IS NULL OR b.expires_at > ?)
         AND (b.token_quota IS NULL OR b.used_tokens < b.token_quota)
         AND (b.request_quota IS NULL OR b.used_requests < b.request_quota)`,
    [userId, now],
  );
  const aliases = new Set<string>();
  const channelIds = new Set<number>();
  for (const row of rows) {
    for (const a of parseAliases(row.allowed_model_aliases)) aliases.add(a);
    for (const id of parseChannelIds(row.allowed_channel_ids)) channelIds.add(id);
  }
  return { aliases: [...aliases], channelIds: [...channelIds] };
}

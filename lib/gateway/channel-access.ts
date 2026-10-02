import { gatewayDb, type DbUser } from "@/lib/core/db";
import { getUserGroup } from "@/lib/gateway/effective-limits";
import { listRedeemScopes } from "@/lib/services/redeem-authorization";

export function parseAllowedChannelIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === "number" ? item : Number(item)))
      .filter((id) => Number.isInteger(id) && id > 0);
  } catch {
    return [];
  }
}

export function stringifyAllowedChannelIds(ids: number[]): string {
  const normalized = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
  return JSON.stringify(normalized);
}

// 用户可用渠道的「候选集合」：组白名单并上定向额度限定的渠道。
// 注意这只是候选范围，用于放开渠道级预过滤；真正的授权判定必须走
// canUserAccessModelOnChannel 的 (渠道, 别名) 配对校验 —— 单看这个并集
// 会把「渠道9 + 别名A」的额度错当成「渠道9」和「别名A」两笔独立授权。
export async function getUserAllowedChannelIds(user: Pick<DbUser, "id" | "role" | "group_id">): Promise<number[] | null> {
  if (user.role === "admin") return null;
  const group = await getUserGroup(user.group_id ?? null);
  const groupIds = group ? parseAllowedChannelIds(group.allowed_channel_ids) : [];
  // 组渠道为空（不限）时保持不限：定向额度只扩大授权，不缩小原本可用的全部渠道
  if (groupIds.length === 0) return null;
  const ids = [...groupIds];
  for (const id of (await listRedeemScopes(user.id)).flatMap((scope) => scope.channelIds)) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export async function listExistingChannelIds(ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = await gatewayDb.query<{ id: number }>(`SELECT id FROM channels WHERE id IN (${placeholders}) AND deleted_at IS NULL`, ids);
  return rows.map((row) => row.id);
}

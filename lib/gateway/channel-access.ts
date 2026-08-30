import { gatewayDb, type DbUser } from "@/lib/core/db";
import { getUserGroup } from "@/lib/gateway/effective-limits";
import { listRedeemCoveredAuthorization } from "@/lib/services/redeem-authorization";

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

export async function getUserAllowedChannelIds(user: Pick<DbUser, "id" | "role" | "group_id">): Promise<number[] | null> {
  if (user.role === "admin") return null;
  const group = await getUserGroup(user.group_id ?? null);
  const groupIds = group ? parseAllowedChannelIds(group.allowed_channel_ids) : [];
  // 组渠道为空（不限）时保持不限：定向额度只扩大授权，不缩小原本可用的全部渠道
  if (groupIds.length === 0) return null;
  const ids = [...groupIds];
  // 定向额度明确限定的渠道作为额外授权来源（兑换即授权）
  const redeem = await listRedeemCoveredAuthorization(user.id);
  for (const id of redeem.channelIds) {
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

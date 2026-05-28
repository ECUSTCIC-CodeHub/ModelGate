import { gatewayDb, type DbUser } from "@/lib/core/db";
import { getUserGroup } from "@/lib/gateway/effective-limits";

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

export function getUserAllowedChannelIds(user: Pick<DbUser, "role" | "group_id">): number[] | null {
  if (user.role === "admin") return null;
  const group = getUserGroup(user.group_id ?? null);
  if (!group) return null;
  const ids = parseAllowedChannelIds(group.allowed_channel_ids);
  return ids.length > 0 ? ids : null;
}

export function listExistingChannelIds(ids: number[]): number[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = gatewayDb
    .prepare(`SELECT id FROM channels WHERE id IN (${placeholders}) AND deleted_at IS NULL`)
    .all(...ids) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

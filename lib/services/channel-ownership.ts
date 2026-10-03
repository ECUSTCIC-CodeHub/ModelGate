import { gatewayDb } from "@/lib/core/db";

// created_by 指向的用户被软删、降权或停用后，渠道视为无主。
// 否则「仅添加人可见」会把渠道永久冻结：所有管理员的添加人判定都为假，
// 连地址、密钥与开关本身都无法修改，只能删除渠道重建。
export async function resolveChannelOwnerId(createdBy: number | null): Promise<number | null> {
  if (createdBy === null) return null;
  const owner = await gatewayDb.queryOne<{ id: number }>(
    "SELECT id FROM users WHERE id = ? AND role = 'admin' AND enabled = 1 AND deleted_at IS NULL",
    [createdBy],
  );
  return owner?.id ?? null;
}

// 列表场景一次性解析，避免逐渠道查询
export async function resolveChannelOwnerIds(createdBys: Array<number | null>): Promise<Set<number>> {
  const candidates = [...new Set(createdBys.filter((id): id is number => id !== null))];
  if (candidates.length === 0) return new Set();
  const placeholders = candidates.map(() => "?").join(", ");
  const rows = await gatewayDb.query<{ id: number }>(
    `SELECT id FROM users WHERE id IN (${placeholders}) AND role = 'admin' AND enabled = 1 AND deleted_at IS NULL`,
    candidates,
  );
  return new Set(rows.map((row) => row.id));
}

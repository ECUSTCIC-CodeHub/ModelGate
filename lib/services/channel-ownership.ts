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

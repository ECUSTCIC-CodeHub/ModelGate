import type { TransactionContext } from "@/lib/core/db/adapter";
import { parseStoredUtc } from "@/lib/core/db/datetime";

export function isModelExpired(expiresAt: string | Date | null | undefined): boolean {
  const date = parseStoredUtc(expiresAt);
  if (!date) return false;
  return date.getTime() <= Date.now();
}

// 在管理员操作任意渠道或模型的事务内调用：扫描所有已启用且设置了过期时间并已过期的模型，
// 将其彻底禁用。无后台定时任务，零持续开销。
export async function disableExpiredModels(tx: TransactionContext): Promise<number> {
  const rows = await tx.query<{ id: number; expires_at: string }>(
    "SELECT id, expires_at FROM models WHERE enabled = 1 AND deleted_at IS NULL AND expires_at IS NOT NULL",
  );
  let disabled = 0;
  for (const row of rows) {
    if (!isModelExpired(row.expires_at)) continue;
    await tx.execute("UPDATE models SET enabled = 0 WHERE id = ?", [row.id]);
    disabled += 1;
  }
  return disabled;
}

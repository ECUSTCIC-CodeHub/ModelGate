import type { TransactionContext } from "@/lib/core/db/adapter";
import { isChannelExpired } from "./channel-time";

// 在管理员操作任意渠道的事务内调用：扫描所有已启用且设置了过期时间并已过期的渠道，
// 将其彻底禁用并级联禁用关联模型。无后台定时任务，零持续开销。
export async function disableExpiredChannels(tx: TransactionContext): Promise<number> {
  const rows = await tx.query<{ id: number; expires_at: string }>(
    "SELECT id, expires_at FROM channels WHERE enabled = 1 AND deleted_at IS NULL AND expires_at IS NOT NULL",
  );
  let disabled = 0;
  for (const row of rows) {
    if (!isChannelExpired(row.expires_at)) continue;
    await tx.execute("UPDATE channels SET enabled = 0 WHERE id = ?", [row.id]);
    await tx.execute("UPDATE models SET enabled = 0 WHERE channel_id = ? AND deleted_at IS NULL", [row.id]);
    disabled += 1;
  }
  return disabled;
}

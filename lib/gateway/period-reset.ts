import { gatewayDb, type DatabaseAdapter } from "@/lib/core/db";
import { parseStoredUtc, toMysqlDatetime } from "@/lib/core/db/datetime";

export type PeriodResetState = {
  period_used_tokens: number;
  period_used_requests: number;
  period_reset_at: string;
};

type PeriodRow = {
  period_used_tokens: number;
  period_used_requests: number;
  period_reset_at: string | null;
};

function normalizeRow(row: PeriodRow, fallback: string): PeriodResetState {
  const parsed = parseStoredUtc(row.period_reset_at);
  return {
    period_used_tokens: row.period_used_tokens,
    period_used_requests: row.period_used_requests,
    // 统一回写为裸字符串：旧格式（RFC3339 带 T/Z）继续外泄会让下游继续踩字典序比较的坑
    period_reset_at: parsed ? toMysqlDatetime(parsed) : fallback,
  };
}

// 周期配额的懒重置。user / channel / model 三处结构完全一致，只是表名与主键不同。
//
// 关键点：守卫里的 `period_reset_at <= ?` 是**字符串**比较。历史数据可能是 RFC3339
// （`2026-10-03T10:00:00Z`），其中 'T'(0x54) 大于裸字符串里的空格(0x20)，导致任何
// 裸字符串 now 都恒小于旧值，条件永不成立、周期配额从此不再重置。因此比较基准必须
// 用解析后的绝对时刻归一成裸字符串，不能直接拿库里的原始值去比。
export async function ensurePeriodReset<Table extends "users" | "channels" | "models">(
  table: Table,
  id: number,
  period: number,
  resetAt: string | null,
  db: DatabaseAdapter = gatewayDb,
): Promise<PeriodResetState> {
  const selectSql = `SELECT period_used_tokens, period_used_requests, period_reset_at FROM ${table} WHERE id = ?`;
  const now = new Date();
  const resetDate = parseStoredUtc(resetAt);

  if (resetDate && resetDate > now) {
    const row = await db.queryOne<PeriodRow>(selectSql, [id]);
    return row
      ? normalizeRow(row, toMysqlDatetime(now))
      : { period_used_tokens: 0, period_used_requests: 0, period_reset_at: toMysqlDatetime(now) };
  }

  const nextReset = toMysqlDatetime(new Date(now.getTime() + period * 1000));
  // 守卫不能用裸字符串比较：库里可能是旧格式（带 T/Z），'T' > ' ' 会让条件恒不成立，
  // 周期配额从此不再重置。改为按绝对时刻判定后，用「值未变」做乐观更新防并发重复重置。
  // resetAt 为 NULL 时不能写 `= NULL`（永远不成立），单独走 IS NULL 分支
  const result = resetAt === null
    ? await db.execute(
        `UPDATE ${table}
           SET period_used_tokens = 0, period_used_requests = 0, period_reset_at = ?
           WHERE id = ? AND period_reset_at IS NULL`,
        [nextReset, id],
      )
    : await db.execute(
        `UPDATE ${table}
           SET period_used_tokens = 0, period_used_requests = 0, period_reset_at = ?
           WHERE id = ? AND period_reset_at = ?`,
        [nextReset, id, resetAt],
      );
  if (result.changes > 0) {
    return { period_used_tokens: 0, period_used_requests: 0, period_reset_at: nextReset };
  }

  // 并发下已被别的请求重置：读回并归一，避免旧格式继续外泄
  const row = await db.queryOne<PeriodRow>(selectSql, [id]);
  return row
    ? normalizeRow(row, nextReset)
    : { period_used_tokens: 0, period_used_requests: 0, period_reset_at: nextReset };
}

import type { DatabaseAdapter } from "@/lib/core/db/adapter";

const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 60_000;
const BATCH_SIZE = 5000;
const SLEEP_BETWEEN_BATCHES_MS = 400;
const MAX_RETENTION_DAYS = 3650;
const DEFAULT_RETENTION_DAYS = 0;

let started = false;
let running = false;

function clampRetention(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_RETENTION_DAYS;
  return Math.min(Math.trunc(raw), MAX_RETENTION_DAYS);
}

async function readCleanupSettings(db: DatabaseAdapter): Promise<{ days: number; enabled: boolean }> {
  const rows = await db.query<{ key: string; value: string }>(
    "SELECT `key`, value FROM settings WHERE `key` IN (?, ?)",
    ["log_retention_days", "log_auto_cleanup_enabled"],
  );
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return {
    days: clampRetention(Number(map.get("log_retention_days") ?? DEFAULT_RETENTION_DAYS)),
    // 未配置时默认关闭自动清理，与设置页默认值一致
    enabled: map.get("log_auto_cleanup_enabled") === "1",
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

// days 会被插值进 SQL，这里强制归一为整数：
// 调用方（API 的 zod 校验）已经保证范围，但该函数不应依赖调用方，避免任何绕过路径
function safeDays(days: number): number {
  const normalized = Math.trunc(Number(days));
  if (!Number.isFinite(normalized) || normalized <= 0) return 0;
  return Math.min(normalized, MAX_RETENTION_DAYS);
}

export async function pruneOldLogs(db: DatabaseAdapter, days: number): Promise<number> {
  const safe = safeDays(days);
  if (safe <= 0) return 0;
  const cutoffExpr = db.driver === "mysql"
    ? `(NOW() - INTERVAL ${safe} DAY)`
    : `datetime('now', '-${safe} days')`;
  const sql = `DELETE FROM logs WHERE id IN (SELECT id FROM (SELECT id FROM logs WHERE created_at < ${cutoffExpr} ORDER BY id ASC LIMIT ${BATCH_SIZE}) AS t)`;
  let deleted = 0;
  for (;;) {
    const result = await db.execute(sql);
    deleted += result.changes;
    if (result.changes < BATCH_SIZE) break;
    await sleep(SLEEP_BETWEEN_BATCHES_MS);
  }
  return deleted;
}

export async function pruneOldEmailLogs(db: DatabaseAdapter, days: number): Promise<number> {
  const safe = safeDays(days);
  if (safe <= 0) return 0;
  // 基准必须与 pruneOldLogs 一致用 UTC：created_at 按全仓约定存 UTC 裸字符串，
  // 带 'localtime' 会把截止点推后一个宿主时区偏移（东八区 8 小时），
  // 未超期的邮件日志被提前删除，而 API.md 承诺失败记录可补发，误删即永久丢失
  const cutoffExpr = db.driver === "mysql"
    ? `(NOW() - INTERVAL ${safe} DAY)`
    : `strftime('%Y-%m-%d %H:%M:%S', 'now', '-${safe} days')`;
  const sql = `DELETE FROM email_send_log WHERE id IN (SELECT id FROM (SELECT id FROM email_send_log WHERE created_at < ${cutoffExpr} ORDER BY id ASC LIMIT ${BATCH_SIZE}) AS t)`;
  let deleted = 0;
  for (;;) {
    const result = await db.execute(sql);
    deleted += result.changes;
    if (result.changes < BATCH_SIZE) break;
    await sleep(SLEEP_BETWEEN_BATCHES_MS);
  }
  return deleted;
}

export function startLogRetentionJob(db: DatabaseAdapter) {
  if (started) return;
  started = true;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const { days, enabled } = await readCleanupSettings(db);
      if (enabled && days > 0) {
        await pruneOldLogs(db, days);
        await pruneOldEmailLogs(db, days);
      }
    } catch {
      // 清理失败不影响网关运行，下次定时再试
    } finally {
      running = false;
    }
  };
  setTimeout(() => { void run(); }, INITIAL_DELAY_MS).unref();
  setInterval(() => { void run(); }, RUN_INTERVAL_MS).unref();
}

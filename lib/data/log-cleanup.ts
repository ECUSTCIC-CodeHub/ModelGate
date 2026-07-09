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

async function readRetentionDays(db: DatabaseAdapter): Promise<number> {
  const row = await db.queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE `key` = ?",
    ["log_retention_days"],
  );
  return clampRetention(Number(row?.value ?? DEFAULT_RETENTION_DAYS));
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

export async function pruneOldLogs(db: DatabaseAdapter, days: number): Promise<number> {
  const cutoffExpr = db.driver === "mysql"
    ? `(NOW() - INTERVAL ${days} DAY)`
    : `datetime('now', '-${days} days')`;
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
  const cutoffExpr = db.driver === "mysql"
    ? `(NOW() - INTERVAL ${days} DAY)`
    : `strftime('%Y-%m-%d %H:%M:%S', 'now', '-${days} days', 'localtime')`;
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
      const days = await readRetentionDays(db);
      if (days > 0) {
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

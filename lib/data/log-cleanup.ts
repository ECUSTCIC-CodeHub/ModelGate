import type { DatabaseAdapter } from "@/lib/core/db/adapter";

const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 60_000;
const BATCH_SIZE = 5000;
const SLEEP_BETWEEN_BATCHES_MS = 400;
const MAX_RETENTION_DAYS = 3650;

let started = false;
let running = false;

function retentionDays(): number {
  const raw = Number(process.env.LOG_RETENTION_DAYS ?? 30);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.trunc(raw), MAX_RETENTION_DAYS);
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

export function startLogRetentionJob(db: DatabaseAdapter) {
  if (started) return;
  started = true;
  const days = retentionDays();
  if (days <= 0) return;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await pruneOldLogs(db, days);
    } catch {
      // 清理失败不影响网关运行，下次定时再试
    } finally {
      running = false;
    }
  };
  setTimeout(() => { void run(); }, INITIAL_DELAY_MS).unref();
  setInterval(() => { void run(); }, RUN_INTERVAL_MS).unref();
}

import { gatewayDb } from "@/lib/core/db";
import { toMysqlDatetime } from "@/lib/core/db/datetime";

const RUN_INTERVAL_MS = 10 * 60_000;
const INITIAL_DELAY_MS = 60_000;
const PURGE_AFTER_MS = 24 * 60 * 60_000;
const LIVE_STATUSES = "('pending', 'delivered')";

let started = false;
let running = false;

async function purgeOnce(): Promise<void> {
  const nowStr = toMysqlDatetime(new Date());
  await gatewayDb.execute(
    `UPDATE dsh_enrollments SET status = 'expired' WHERE status IN ${LIVE_STATUSES} AND expires_at < ?`,
    [nowStr],
  );
  await gatewayDb.execute(
    `DELETE FROM dsh_enrollments WHERE status IN ('expired', 'redeemed', 'revoked') AND expires_at < ?`,
    [toMysqlDatetime(new Date(Date.now() - PURGE_AFTER_MS))],
  );
}

export function startDshEnrollmentReaper() {
  if (started) return;
  started = true;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await purgeOnce();
    } catch {
      // 清理失败不影响授权流程，下次定时再试
    } finally {
      running = false;
    }
  };
  setTimeout(() => { void run(); }, INITIAL_DELAY_MS).unref();
  setInterval(() => { void run(); }, RUN_INTERVAL_MS).unref();
}

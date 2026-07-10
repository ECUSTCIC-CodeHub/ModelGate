import { gatewayDb } from "@/lib/core/db";
import { getGatewaySettings } from "@/lib/core/settings";
import { toMysqlDatetime } from "@/lib/core/db/datetime";

const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 60_000;
const MAX_EXPIRE_DAYS = 3650;
const DEFAULT_EXPIRE_DAYS = 30;

let started = false;
let running = false;

function clampDays(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_EXPIRE_DAYS;
  return Math.min(Math.trunc(raw), MAX_EXPIRE_DAYS);
}

export async function expireStaleOidcGroups(): Promise<number> {
  const settings = await getGatewaySettings();
  const days = clampDays(settings.oidc_group_expire_days);
  if (days <= 0) return 0;

  const defaultGroup = await gatewayDb
    .queryOne<{ id: number }>("SELECT id FROM `groups` WHERE is_default = 1 AND deleted_at IS NULL");
  const defaultId = defaultGroup?.id ?? null;

  const cutoff = toMysqlDatetime(new Date(Date.now() - days * 86_400_000));

  const sql = `
    UPDATE users
    SET group_id = ?, oidc_group_synced_at = NULL
    WHERE id IN (
      SELECT id FROM (
        SELECT u.id FROM users u
        JOIN \`groups\` g ON g.id = u.group_id
        WHERE g.oidc_claim_expr IS NOT NULL AND g.oidc_claim_expr != ''
          AND g.deleted_at IS NULL
          AND (u.group_locked = 0 OR u.group_locked IS NULL)
          AND u.oidc_group_synced_at IS NOT NULL
          AND u.oidc_group_synced_at < ?
          AND u.deleted_at IS NULL
      ) AS t
    )`;

  const result = await gatewayDb.execute(sql, [defaultId, cutoff]);
  return result.changes;
}

export function startOidcGroupExpiryJob() {
  if (started) return;
  started = true;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await expireStaleOidcGroups();
    } catch {
      // 过期任务失败不影响网关运行，下次定时再试
    } finally {
      running = false;
    }
  };
  setTimeout(() => { void run(); }, INITIAL_DELAY_MS).unref();
  setInterval(() => { void run(); }, RUN_INTERVAL_MS).unref();
}

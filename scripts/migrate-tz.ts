// 时区数据迁移工具：把存量「上海墙上时间」统一转成 UTC 存储。
//
// 用法：
//   node --experimental-strip-types scripts/migrate-tz.ts            # 实际迁移
//   node --experimental-strip-types scripts/migrate-tz.ts --dry-run  # 仅预览，不写库
//
// 迁移前请备份数据库。幂等：完成后写入 settings.tz_utc_migrated=1，重复执行会跳过。
//
// 背景：历史代码按 Asia/Shanghai 墙上时间存储所有时间字段；本次重构后统一按 UTC 存储。
// MySQL 几乎所有时间列都是上海时间（统一减 8 小时）；SQLite 存量混乱——
// 应用层 toMysqlDatetime 写的列是上海时间（减 8 小时），CURRENT_TIMESTAMP/datetime('now') 写的列本就是 UTC（不动）。

import { initializeGatewayDbAsync } from "../lib/core/db/init";
import type { DatabaseAdapter } from "../lib/core/db/adapter";

const SHANGHAI = "Asia/Shanghai";
const MIGRATED_KEY = "tz_utc_migrated";
const MIGRATING_KEY = "tz_utc_migrating";

// 所有 DATETIME 列，按表分组。MySQL 统一减 8 小时；SQLite 仅减「应用层写」的列。
const MYSQL_DATETIME_COLUMNS: Array<{ table: string; columns: string[] }> = [
  { table: "logs", columns: ["created_at"] },
  { table: "users", columns: ["created_at", "deleted_at", "period_reset_at", "oidc_group_synced_at"] },
  { table: "keys", columns: ["created_at", "deleted_at", "last_used_at"] },
  { table: "channels", columns: ["created_at", "deleted_at", "period_reset_at", "expires_at"] },
  { table: "models", columns: ["created_at", "deleted_at", "period_reset_at"] },
  { table: "groups", columns: ["created_at", "deleted_at"] },
  { table: "settings", columns: ["updated_at"] },
  { table: "announcements", columns: ["created_at"] },
  { table: "email_senders", columns: ["created_at"] },
  { table: "email_send_log", columns: ["created_at"] },
];

// SQLite：只有应用层 toMysqlDatetime/toLocalDatetime 写的列是上海时间，需减 8 小时。
// 其余（created_at/deleted_at/last_used_at/updated_at/logs.created_at）由 CURRENT_TIMESTAMP 写，本就是 UTC，不动。
const SQLITE_SHIFT_COLUMNS: Array<{ table: string; columns: string[] }> = [
  { table: "users", columns: ["period_reset_at", "oidc_group_synced_at"] },
  { table: "channels", columns: ["period_reset_at", "expires_at"] },
  { table: "models", columns: ["period_reset_at"] },
  { table: "email_send_log", columns: ["created_at"] },
];

function shiftShanghaiToUtc(dateLike: string | null): string | null {
  if (!dateLike) return null;
  // 存量是上海墙上时间（无时区后缀），按上海解释为绝对时刻再取 UTC。
  const d = new Date(dateLike.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return dateLike;
  // d 被按 Node 进程时区（容器 Asia/Shanghai）解析为绝对时刻；取 UTC 墙上串。
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function shiftHhmmShanghaiToUtc(hhmm: string): { utc: string; dayShift: number } | null {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  const base = new Date();
  const dayStart = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
  const target = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  let best: { utcMs: number; tzWeekday: number } | null = null;
  for (let off = 0; off < 86400_000; off += 60_000) {
    const candidate = new Date(dayStart + off);
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: SHANGHAI, hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false });
    const parts = fmt.formatToParts(candidate);
    const hour = (parts.find((p) => p.type === "hour")?.value ?? "00");
    const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
    if (`${hour === "24" ? "00" : hour}:${minute}` === target) {
      const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
      const tzWd = (["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd));
      best = { utcMs: off, tzWeekday: tzWd === 0 ? 7 : tzWd === -1 ? 1 : tzWd };
      break;
    }
  }
  if (!best) return null;
  const utcDate = new Date(dayStart + best.utcMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const utc = `${pad(utcDate.getUTCHours())}:${pad(utcDate.getUTCMinutes())}`;
  const matchedUtcWd = (() => { const d = utcDate.getUTCDay(); return d === 0 ? 7 : d; })();
  const dayShift = ((matchedUtcWd - best.tzWeekday + 7) % 7);
  return { utc, dayShift: dayShift > 3 ? dayShift - 7 : dayShift };
}

function shiftDay(day: number, shift: number): number {
  return ((day - 1 + shift) % 7 + 7) % 7 + 1;
}

async function migrateTimeRestrictions(db: DatabaseAdapter, dryRun: boolean): Promise<number> {
  const rows = await db.query<{ id: number; time_restrictions: string | null }>(
    "SELECT id, time_restrictions FROM channels WHERE time_restrictions IS NOT NULL AND time_restrictions != ''",
  );
  let changed = 0;
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.time_restrictions ?? "");
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    let dirty = false;
    const next = parsed.map((win: unknown) => {
      if (!win || typeof win !== "object") return win;
      const w = win as Record<string, unknown>;
      const start = typeof w.start === "string" ? w.start : "";
      const end = typeof w.end === "string" ? w.end : "";
      if (!start || !end) return w;
      const s = shiftHhmmShanghaiToUtc(start);
      const e = shiftHhmmShanghaiToUtc(end);
      if (!s || !e) return w;
      dirty = true;
      const days = Array.isArray(w.days) ? (w.days as unknown[]).map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7) : [];
      return {
        days: [...new Set(days.map((d) => shiftDay(d, s.dayShift)))].sort((a, b) => a - b),
        start: s.utc,
        end: e.utc,
      };
    });
    if (!dirty) continue;
    const json = JSON.stringify(next);
    if (!dryRun) {
      await db.execute("UPDATE channels SET time_restrictions = ? WHERE id = ?", [json, row.id]);
    }
    changed++;
    console.log(`  channels#${row.id} time_restrictions → ${json}`);
  }
  return changed;
}

async function migrateMysql(db: DatabaseAdapter, dryRun: boolean): Promise<void> {
  let totalAffected = 0;
  for (const { table, columns } of MYSQL_DATETIME_COLUMNS) {
    for (const col of columns) {
      const safeCol = "`" + col + "`";
      const countRow = await db.queryOne<{ c: number }>(
        `SELECT COUNT(*) AS c FROM \`${table}\` WHERE ${safeCol} IS NOT NULL`,
      );
      const count = countRow?.c ?? 0;
      if (count === 0) continue;
      if (!dryRun) {
        await db.execute(
          `UPDATE \`${table}\` SET ${safeCol} = DATE_SUB(${safeCol}, INTERVAL 8 HOUR) WHERE ${safeCol} IS NOT NULL`,
        );
        if (table === "logs") console.log(`  ${table}.${col}: ${count} rows (单条全表 UPDATE，预期锁表)`);
        else console.log(`  ${table}.${col}: ${count} rows`);
      } else {
        console.log(`  [dry-run] ${table}.${col}: ${count} rows would shift -8h`);
      }
      totalAffected += count;
    }
  }
  console.log(`MySQL datetime columns: ${dryRun ? "would affect" : "affected"} ${totalAffected} rows total`);

  const trChanged = await migrateTimeRestrictions(db, dryRun);
  console.log(`MySQL time_restrictions: ${dryRun ? "would change" : "changed"} ${trChanged} channels`);
}

async function migrateSqlite(db: DatabaseAdapter, dryRun: boolean): Promise<void> {
  let totalAffected = 0;
  for (const { table, columns } of SQLITE_SHIFT_COLUMNS) {
    for (const col of columns) {
      const rows = await db.query<{ id: number; [k: string]: unknown }>(
        `SELECT id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`,
      );
      if (rows.length === 0) continue;
      let n = 0;
      for (const row of rows) {
        const shifted = shiftShanghaiToUtc(row.v as string | null);
        if (shifted === row.v) continue;
        if (!dryRun) {
          await db.execute(`UPDATE ${table} SET ${col} = ? WHERE id = ?`, [shifted, row.id]);
        }
        n++;
      }
      console.log(`  ${dryRun ? "[dry-run] " : ""}${table}.${col}: ${n} rows ${dryRun ? "would shift" : "shifted"} -8h`);
      totalAffected += n;
    }
  }
  console.log(`SQLite datetime columns: ${dryRun ? "would affect" : "affected"} ${totalAffected} rows total`);

  const trChanged = await migrateTimeRestrictions(db, dryRun);
  console.log(`SQLite time_restrictions: ${dryRun ? "would change" : "changed"} ${trChanged} channels`);
}

async function main() {
  // 迁移依赖进程按 Asia/Shanghai 解释存量「无时区串」，必须在 new Date 首次使用前固定 TZ。
  process.env.TZ = SHANGHAI;
  const dryRun = process.argv.includes("--dry-run");
  console.log(`=== 时区迁移 (${dryRun ? "DRY-RUN 预览" : "实际执行"}) ===`);
  console.log("注意：请确保已备份数据库。\n");

  const db = await initializeGatewayDbAsync();
  const driver = await db.getDriver();
  const isMysql = driver === "mysql";
  const upsert = (key: string, value: string) => {
    const sql = isMysql
      ? "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)"
      : "INSERT INTO settings (`key`, value) VALUES (?, ?) ON CONFLICT(`key`) DO UPDATE SET value = excluded.value";
    return db.execute(sql, [key, value]);
  };

  const done = await db.queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE `key` = ?",
    [MIGRATED_KEY],
  );
  if (done?.value === "1") {
    console.log("已检测到 tz_utc_migrated 标记，数据库已迁移过，跳过。");
    await db.close();
    process.exit(0);
  }

  const migrating = await db.queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE `key` = ?",
    [MIGRATING_KEY],
  );
  if (migrating?.value === "1") {
    console.error(`检测到 ${MIGRATING_KEY}=1，说明上次迁移未正常完成（可能中途失败）。`);
    console.error("禁止直接重跑：部分列可能已被减 8 小时，重跑会二次偏移。请从备份恢复数据库后再执行。");
    process.exit(1);
  }

  if (!dryRun) await upsert(MIGRATING_KEY, "1");

  if (isMysql) {
    await migrateMysql(db, dryRun);
  } else {
    await migrateSqlite(db, dryRun);
  }

  if (!dryRun) {
    await upsert(MIGRATED_KEY, "1");
    await db.execute("DELETE FROM settings WHERE `key` = ?", [MIGRATING_KEY]);
    console.log(`\n迁移完成，已写入标记 ${MIGRATED_KEY}=1。`);
  } else {
    console.log("\n[dry-run] 未写入任何数据，未设置迁移标记。");
  }

  await db.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("迁移失败：", err);
  process.exit(1);
});

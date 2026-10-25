// 周期档位的懒重置。
//
// 与 period-cycles.ts 分开的原因：这里需要访问数据库，而解析/校验/序列化是纯逻辑，
// 前端编辑组件也要复用。拆开后前端只依赖无副作用的 period-cycles.ts，
// 不会把数据库驱动打进浏览器构建。
//
// 守卫不能用**裸字符串**比较：历史数据可能是 RFC3339（`2026-10-03T10:00:00Z`），
// 其中 'T'(0x54) 大于裸字符串里的空格(0x20)，导致任何裸字符串 now 都恒小于旧值、
// 条件永不成立，周期配额从此不再重置。因此比较基准一律用解析后的绝对时刻，
// 回写统一成裸字符串。

import { gatewayDb, ensureDbReady, type DatabaseAdapter } from "@/lib/core/db";
import { parseStoredUtc, toMysqlDatetime } from "@/lib/core/db/datetime";
import { parsePeriodCycles, serializePeriodCycleState, type PeriodCycle } from "./period-cycles";

// 只依赖执行与查询能力，因此既能传 DatabaseAdapter，也能传事务上下文，
// 让计费侧在同一个事务里完成「重置 + 累加」，避免跨连接导致状态不一致。
export type CycleResetExecutor = Pick<DatabaseAdapter, "execute" | "queryOne">;

// 计数列名。users 有两套：自有档 period_cycles、继承自组的档位 group_period_cycles。
// 两者必须分开存取，否则组档会被物化成用户自有档，组后续调整对该用户永久失效。
export type CycleStateColumn = "period_cycles" | "group_period_cycles";

// 返回重置后的档位数组；未发生重置时原样返回（不写库）。
//
// guardRaw 是调用方从库里读到的 period_cycles **原始文本**，作为乐观更新的守卫。
// 不能用「重新序列化后的值」当守卫：那与列里存的原始文本可能不一致
// （历史数据可能是 RFC3339 或字段顺序不同的 JSON），守卫会永不命中，
// 于是 changes === 0、又采信库里仍未重置的旧值，该对象会被永久拒绝且无法自愈。
export async function ensureCycleResets<Table extends "users" | "channels" | "models" | "redeem_balances">(
  table: Table,
  id: number,
  cycles: PeriodCycle[],
  db: CycleResetExecutor = gatewayDb,
  guardRaw?: string | null,
  column: CycleStateColumn = "period_cycles",
): Promise<PeriodCycle[]> {
  if (cycles.length === 0) return cycles;

  // 用 ensureDbReady 取方言：gatewayDb.driver 在未初始化时会返回 Promise（真值但不等于 "mysql"），
  // 直接比较会误选 SQLite 分支。
  const isMysql = (await ensureDbReady()).driver === "mysql";
  const now = new Date();
  let dirty = false;
  const next = cycles.map((cycle) => {
    const resetDate = cycle.reset_at ? parseStoredUtc(cycle.reset_at) : null;
    // 未配置过锚点，或锚点已过期，都视为需要开启/推进新窗口
    if (resetDate && resetDate > now) return cycle;
    dirty = true;
    return {
      ...cycle,
      used_tokens: 0,
      used_requests: 0,
      reset_at: toMysqlDatetime(new Date(now.getTime() + cycle.seconds * 1000)),
    };
  });

  if (!dirty) return cycles;

  // 乐观更新：以「读到的原始值」为守卫，并发下只有一个请求写入成功。
  // 两条 SQL 分别服务两种方言：MySQL 的 `IS` 只接受 NULL/TRUE/FALSE/UNKNOWN 字面量，
  // 不接受占位符（参数化的空安全比较要用 `<=>`）；SQLite 两者皆可。
  // 这里按方言分支，避免在 MySQL 上直接语法报错。
  const guardedUpdate = (value: PeriodCycle[], guard: string | null) => (
    isMysql
      ? db.execute(
        `UPDATE ${table} SET ${column} = ? WHERE id = ? AND ${column} <=> ?`,
        [serializePeriodCycleState(value), id, guard],
      )
      : db.execute(
        `UPDATE ${table} SET ${column} = ? WHERE id = ? AND ${column} IS ?`,
        [serializePeriodCycleState(value), id, guard],
      )
  );

  if ((await guardedUpdate(next, guardRaw ?? null)).changes > 0) return next;

  // 未命中说明并发下已被他人改写：采信库里的最新值。
  // 列名必须按 column 动态取值：SQL 已经选的是 column，读值时再写死 period_cycles
  // 会让 group_period_cycles 这条路径永远读到 undefined，从而绕过下面的兜底推进。
  const readColumn = async (): Promise<string | null> => {
    const row = await db.queryOne<Record<string, string | null>>(
      `SELECT ${column} AS value FROM ${table} WHERE id = ?`,
      [id],
    );
    return row?.value ?? null;
  };
  const firstRead = await readColumn();
  const current = parsePeriodCycles(firstRead);
  if (current.length === 0) return next;

  const stillExpired = current.some((cycle) => {
    const resetDate = cycle.reset_at ? parseStoredUtc(cycle.reset_at) : null;
    return !resetDate || resetDate <= now;
  });
  // 库里的值已经推进过窗口，直接采信，避免把刚开启的窗口又重置一次（那等于白送额度）。
  if (!stillExpired) return current;

  // 兜底推进：守卫本身失配（历史数据文本形态与序列化结果不一致）时上面必然未命中，
  // 若不推进就会把「过期未重置」的状态一直返回给调用方，该对象被永久拒绝且无法自愈。
  // 这里用刚读到的原始文本再守卫一次，避免覆盖这一瞬间被其他事务累加进去的用量。
  const forced = current.map((cycle) => {
    const resetDate = cycle.reset_at ? parseStoredUtc(cycle.reset_at) : null;
    if (resetDate && resetDate > now) return cycle;
    return {
      ...cycle,
      used_tokens: 0,
      used_requests: 0,
      reset_at: toMysqlDatetime(new Date(now.getTime() + cycle.seconds * 1000)),
    };
  });
  if ((await guardedUpdate(forced, firstRead)).changes > 0) return forced;

  // 仍未命中：并发方刚刚又改过，采信它的值而非覆盖。
  const parsedLatest = parsePeriodCycles(await readColumn());
  return parsedLatest.length > 0 ? parsedLatest : forced;
}

// 读取「继承自用户组的周期档」在该用户上的运行时状态，并按需推进窗口。
//
// 计数存在 users.group_period_cycles，与用户自有档 period_cycles 分开：
// 否则组档会被物化成用户自有档，组后续收紧/放宽/删除对该用户永久失效，
// 已删除的组限制还会继续拦人。
// 传入的 definitions 是组当前的档位定义（已被自有档按秒数覆盖过滤），
// 这里把同一秒数已存在的计数接上，未存在的从 0 起算；
// 组里删掉的档位不会被带回来，因此组配置变更立即生效。
// persist=false 用于纯读取场景（管理端列表/详情/用户自查）：那里只是把生效档位
// 渲染出来，不产生用量，推进窗口的活儿留给判定侧和计费侧。
// 缺省 true 时，这里会把「原样回写的旧状态」也写进 group_period_cycles，
// 于是「用户档显式覆盖组档」之后，残留的继承计数会在下一次查看时被复活。
export async function loadGroupCycleState(
  userId: number,
  definitions: PeriodCycle[],
  db: CycleResetExecutor = gatewayDb,
  persist = true,
): Promise<PeriodCycle[]> {
  if (definitions.length === 0) return [];
  const row = await db.queryOne<{ group_period_cycles: string | null }>(
    "SELECT group_period_cycles FROM users WHERE id = ?",
    [userId],
  );
  const stored = parsePeriodCycles(row?.group_period_cycles);
  const bySeconds = new Map(stored.map((cycle) => [cycle.seconds, cycle]));
  const merged = definitions.map((definition) => {
    const prior = bySeconds.get(definition.seconds);
    if (!prior) return definition;
    return {
      ...definition,
      used_tokens: prior.used_tokens,
      used_requests: prior.used_requests,
      reset_at: prior.reset_at,
    };
  });
  if (!persist) return merged;
  return ensureCycleResets("users", userId, merged, db, row?.group_period_cycles ?? null, "group_period_cycles");
}

import { gatewayDb, ensureDbReady } from "@/lib/core/db";
import { modelGateFeatures } from "@/lib/core/features";
import { getGatewaySettings } from "@/lib/core/settings";
import { parseStoredUtc, toMysqlDatetime } from "@/lib/core/db/datetime";
import {
  applyCycleUsage,
  isInheritedQuota,
  parseInheritGroupPeriods,
  parsePeriodCycles,
  serializePeriodCycleState,
  type PeriodCycle,
} from "@/lib/gateway/period-cycles";
import { resolveEnforcedCycles } from "@/lib/gateway/effective-limits";
import { ensureCycleResets } from "@/lib/gateway/period-cycles-reset";
import { parseMultiplierSchedules, resolveEffectiveMultiplier } from "@/lib/gateway/multiplier-schedule";
import { buildRedeemScope, scopeCoversPair, balanceHasRemaining } from "@/lib/services/redeem-authorization";

function cleanFloat(value: number): number {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 1e-6) return rounded;
  return Math.round(value * 1e6) / 1e6;
}

// 周期档的计数存在 period_cycles JSON 列里，无法用一条 UPDATE 按档累加，只能读改写。
// 调用点都在 addUsageOrThrow 的事务内；MySQL 默认 REPEATABLE READ 下普通 SELECT 是非锁定读，
// 两个并发事务会读到同一份旧值、后写者覆盖先写者（丢失一次累加），
// 因此按方言加行锁，与总量列 SET x = x + ? 的原子性对齐。
// SQLite 写事务本身串行，无需也不会支持 FOR UPDATE。
async function accumulateCycles(
  tx: TransactionContextLike,
  table: "users" | "channels" | "models" | "redeem_balances",
  id: number,
  deltaTokens: number,
  deltaRequests: number,
  inherited: PeriodCycle[] = [],
): Promise<void> {
  // 用 ensureDbReady 取方言：gatewayDb.driver 在未初始化时会返回 Promise（真值但不等于 "mysql"），
  // 直接比较会漏加行锁。
  const isMysql = (await ensureDbReady()).driver === "mysql";
  // 只有 users 有 group_period_cycles；其余表保持单列查询，避免引用不存在的列。
  const cycleSelect = table === "users"
    ? "period_cycles, group_period_cycles"
    : "period_cycles, NULL AS group_period_cycles";
  const row = await tx.queryOne<{
    period_cycles: string | null;
    group_period_cycles: string | null;
  }>(
    `SELECT ${cycleSelect} FROM ${table} WHERE id = ?${isMysql ? " FOR UPDATE" : ""}`,
    [id],
  );
  if (!row) return;
  // 自有档与继承档分开累加：继承自用户组的档位计数写 users.group_period_cycles，
  // 不能混进 period_cycles，否则组档会被物化成用户自有档，
  // 组后续收紧/放宽/删除对该用户永久失效，已删除的组限制还会继续拦人。
  // 周期档只认 period_cycles：旧单档列已停止写入与自增，启动迁移已把存量单档配置折成档位。
  const ownCycles = parsePeriodCycles(row.period_cycles);
  if (table !== "users") {
    if (ownCycles.length > 0) {
      await tx.execute(
        `UPDATE ${table} SET period_cycles = ? WHERE id = ?`,
        [serializePeriodCycleState(applyCycleUsage(ownCycles, deltaTokens, deltaRequests)), id],
      );
    }
    return;
  }
  // 生效口径只在这里算一次：判定侧、展示侧、计费侧共用 resolveEnforcedCycles，
  // 保证「哪些档在管这个用户」只有一份真值。
  // 注意 enforced.own 是**用户自己写下的形状**（不含从组档让位来的额度），
  // 因此回写 users.period_cycles 时额度天然不会被物化。
  const enforced = resolveEnforcedCycles(ownCycles, inherited);

  // 自有档里真正归属 own 的秒数：只有用户自己写了额度的档位。
  // 两侧留空的档位额度全来自组档（或根本没有上游），计数一律走继承档那一列：
  // 两边都记会让同一次请求被算两遍，界面上的「不限制」档也会莫名涨用量。
  const passThroughSeconds = new Set(enforced.passThrough);
  const billableOwn = enforced.own.filter((cycle) => (
    !passThroughSeconds.has(cycle.seconds) && !isInheritedQuota(cycle.quota_tokens, cycle.quota_requests)
  ));
  if (billableOwn.length > 0) {
    const ownSeconds = new Set(billableOwn.map((cycle) => cycle.seconds));
    const nextOwn = ownCycles.map((cycle) => (
      ownSeconds.has(cycle.seconds) ? applyCycleUsage([cycle], deltaTokens, deltaRequests)[0] : cycle
    ));
    await tx.execute(
      "UPDATE users SET period_cycles = ? WHERE id = ?",
      [serializePeriodCycleState(nextOwn), id],
    );
  }

  // 生效口径里落到自有档的秒数不再属于继承档：用户写了显式额度覆盖组档，
  // 必须把 group_period_cycles 里同秒数的残留计数清掉，否则切回「覆盖」后
  // 内存里的旧计数会被下一次累加写回来，组档的用量继续在后台叠加。
  const ownSecondsSet = new Set(billableOwn.map((cycle) => cycle.seconds));
  const effectiveInherited = enforced.inherited;
  const storedInherited = parsePeriodCycles(row.group_period_cycles)
    .filter((cycle) => !ownSecondsSet.has(cycle.seconds));
  // 组已清空周期档（或全部被自有档覆盖）时清掉残留计数：
  // 这些档位不再参与判定，留着只会占空间。
  if (effectiveInherited.length === 0) {
    if (storedInherited.length > 0) {
      await tx.execute("UPDATE users SET group_period_cycles = NULL WHERE id = ?", [id]);
    }
    return;
  }
  const storedBySeconds = new Map(storedInherited.map((cycle) => [cycle.seconds, cycle]));
  const mergedInherited = effectiveInherited.map((cycle) => {
    const prior = storedBySeconds.get(cycle.seconds);
    return prior ? { ...cycle, used_tokens: prior.used_tokens, used_requests: prior.used_requests, reset_at: prior.reset_at } : cycle;
  });
  await tx.execute(
    "UPDATE users SET group_period_cycles = ? WHERE id = ?",
    [serializePeriodCycleState(applyCycleUsage(mergedInherited, deltaTokens, deltaRequests)), id],
  );
}

// 事务内读取用户所属用户组的周期档定义。组档按每用户独立计数，
// 因此只需定义值，运行时计数记在用户行上。查不到组时返回空数组，不影响计费。
async function loadUserGroupCycles(tx: TransactionContextLike, userId: number): Promise<PeriodCycle[]> {
  const row = await tx.queryOne<{ period_cycles: string | null; inherit_group_periods: number | null }>(
    `SELECT g.period_cycles, u.inherit_group_periods FROM users u
       JOIN \`groups\` g ON g.id = u.group_id
      WHERE u.id = ? AND g.enabled = 1 AND g.deleted_at IS NULL`,
    [userId],
  );
  // 关掉「继承用户组周期配额」总开关的用户，组档对计费侧同样不可见：
  // 否则判定侧放行（组档不参与），计费侧却还在往 group_period_cycles 里累加，
  // 一旦重新打开开关，关闭期间用掉的量会突然压上来。
  if (!parseInheritGroupPeriods(row?.inherit_group_periods)) return [];
  return parsePeriodCycles(row?.period_cycles);
}

// 事务内查找匹配当前渠道+模型的用户有效定向额度。
async function findMatchingBalanceInTx(
  tx: TransactionContextLike,
  userId: number,
  channelId: number,
  modelAlias: string,
): Promise<{ id: number } | null> {
  const rows = await tx.query<{
    id: number;
    token_quota: number | null;
    request_quota: number | null;
    used_tokens: number;
    used_requests: number;
    allowed_channel_ids: string;
    allowed_model_aliases: string;
    expires_at: string | null;
    period_cycles: string | null;
  }>(
    `SELECT b.id, b.token_quota, b.request_quota, b.used_tokens, b.used_requests,
            b.allowed_channel_ids, b.allowed_model_aliases, b.expires_at, b.period_cycles
       FROM redeem_balances b
       JOIN redeem_codes c ON c.id = b.code_id
       WHERE b.user_id = ?
         AND c.enabled = 1
         AND (b.expires_at IS NULL OR b.expires_at > ?)
         AND (b.token_quota IS NULL OR b.used_tokens < b.token_quota)
         AND (b.request_quota IS NULL OR b.used_requests < b.request_quota)
       ORDER BY b.id`,
    [userId, toMysqlDatetime(new Date())],
  );

  for (const row of rows) {
    const remainingTokens = row.token_quota !== null ? row.token_quota - row.used_tokens : null;
    const remainingRequests = row.request_quota !== null ? row.request_quota - row.used_requests : null;
    if (remainingTokens !== null && remainingTokens <= 0) continue;
    if (remainingRequests !== null && remainingRequests <= 0) continue;
    // 先推进已到期的周期窗口再判定：核销快照只带定义值、reset_at 为 null，
    // 不推进的话周期额度会退化成一次性总额度，首周期用尽后永久不可用。
    // 事务内重置，与随后同一事务里的累加共用同一条连接。
    let cycles = parsePeriodCycles(row.period_cycles);
    if (modelGateFeatures.periodQuota && cycles.length > 0) {
      cycles = await ensureCycleResets("redeem_balances", row.id, cycles, tx, row.period_cycles);
      row.period_cycles = serializePeriodCycleState(cycles);
    }
    // 周期档耗尽时不再命中，与 findMatchingRedeemBalance / listRedeemScopes 的口径一致
    if (!balanceHasRemaining(row)) continue;
    if (row.expires_at) {
      const expires = parseStoredUtc(row.expires_at);
      if (expires && expires.getTime() <= Date.now()) continue;
    }
    // 与授权侧的配对判定共用同一份逻辑，避免两处规则漂移。
    if (scopeCoversPair(buildRedeemScope(row.allowed_channel_ids, row.allowed_model_aliases), channelId, modelAlias)) {
      return { id: row.id };
    }
  }
  return null;
}

type TransactionContextLike = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
};

// 失败日志限频：数据库故障时每个请求都会失败，逐条打印会淹没日志并放大 IO。
// 同一时间窗内只输出首条，并附上被折叠的条数，保证既可见又不刷屏
const USAGE_ERROR_LOG_INTERVAL_MS = 10_000;
let lastUsageErrorLoggedAt = 0;
let suppressedUsageErrors = 0;

function logUsageFailure(message: string, error: unknown) {
  const now = Date.now();
  if (now - lastUsageErrorLoggedAt < USAGE_ERROR_LOG_INTERVAL_MS) {
    suppressedUsageErrors += 1;
    return;
  }
  const suppressed = suppressedUsageErrors;
  suppressedUsageErrors = 0;
  lastUsageErrorLoggedAt = now;
  const suffix = suppressed > 0 ? `（另有 ${suppressed} 次同类失败被折叠）` : "";
  console.error(`${message}${suffix}`, error instanceof Error ? error.message : error);
}

// 按请求时刻解析模型的分时倍率。未配置时段、或时段都未命中时返回基础倍率。
// 查询失败不阻断计费：退化为基础倍率，避免因为一次读库异常丢掉整次用量累加。
async function resolveScheduledMultiplier(
  modelId: number | undefined,
  baseTokenMultiplier: number,
  baseRequestMultiplier: number,
): Promise<{ token_multiplier: number; request_multiplier: number }> {
  const fallback = { token_multiplier: baseTokenMultiplier, request_multiplier: baseRequestMultiplier };
  if (modelId == null || !modelGateFeatures.periodQuota) return fallback;
  try {
    const row = await gatewayDb.queryOne<{ multiplier_schedules: string | null }>(
      "SELECT multiplier_schedules FROM models WHERE id = ?",
      [modelId],
    );
    const schedules = parseMultiplierSchedules(row?.multiplier_schedules);
    if (schedules.length === 0) return fallback;
    return resolveEffectiveMultiplier(baseTokenMultiplier, baseRequestMultiplier, schedules);
  } catch (error) {
    logUsageFailure(`[usage] 分时倍率解析失败 model=${modelId}，回退基础倍率:`, error);
    return fallback;
  }
}

export async function addUsage(userId: number, keyId: number, tokens: number, requests = 1, tokenMultiplier = 1, requestMultiplier = 1, channelId?: number, modelId?: number, modelAlias?: string | null, redeemBalanceId?: number | null) {
  try {
    await addUsageOrThrow(userId, keyId, tokens, requests, tokenMultiplier, requestMultiplier, channelId, modelId, modelAlias, redeemBalanceId);
  } catch (error) {
    // 所有调用点都是 fire-and-forget（不 await、不 catch），累加失败原本会变成
    // unhandled rejection 并被静默吞掉：响应正常返回、日志正常写入，但配额没有扣减，
    // 偏差无法排查。这里兜底记录，至少让问题可见
    logUsageFailure(
      `[usage] 用量累加失败 user=${userId} key=${keyId} channel=${channelId ?? "-"} model=${modelAlias ?? "-"}:`,
      error,
    );
  }
}

async function addUsageOrThrow(userId: number, keyId: number, tokens: number, requests = 1, tokenMultiplier = 1, requestMultiplier = 1, channelId?: number, modelId?: number, modelAlias?: string | null, redeemBalanceId?: number | null) {
  // 分时倍率在计费点统一解析：调用方传的仍是模型的基础倍率，这里按请求时刻覆盖。
  // 放在这里而不是各个调用点，避免流式/非流式/透传多条路径各自实现导致口径漂移。
  const effective = await resolveScheduledMultiplier(modelId, tokenMultiplier, requestMultiplier);
  const billedTokens = cleanFloat(Math.max(0, tokens * effective.token_multiplier));
  const billedRequests = cleanFloat(Math.max(0, requests * effective.request_multiplier));
  const settings = await getGatewaySettings();

  await gatewayDb.transaction(async (tx) => {
    // 命中用户定向额度（兑换码）时，从定向额度中扣减，且不再计入用户全局用量。
    // 优先使用请求时守卫已确认命中的定向额度（redeemBalanceId），保证“跳过全局配额检查”与实际扣减针对同一定向额度，
    // 避免定向额度在请求期间耗尽/过期后回落到未检查过的用户全局配额。
    let coveredByRedeem = false;
    if (channelId != null && modelAlias && settings.runtime_features.redeemCode) {
      const balanceId = redeemBalanceId ?? (await findMatchingBalanceInTx(tx, userId, channelId, modelAlias))?.id ?? null;
      if (balanceId != null) {
        // 仅当该定向额度仍存在（未被删除）时才视为已覆盖，避免余额被删除后形成免费使用
        const updated = await tx.execute(
          `UPDATE redeem_balances
             SET used_tokens = used_tokens + ?, used_requests = used_requests + ?
             WHERE id = ?`,
          [billedTokens, billedRequests, balanceId],
        );
        coveredByRedeem = updated.changes === 1;
        if (coveredByRedeem && modelGateFeatures.periodQuota) {
          await accumulateCycles(tx, "redeem_balances", balanceId, billedTokens, billedRequests);
        }
      }
    }

    if (!coveredByRedeem) {
      if (modelGateFeatures.periodQuota) {
        // 周期用量只累加到 period_cycles 的档位计数器里，旧列 period_used_* 已停止写入。
        await tx.execute(
          `UPDATE users
             SET used_tokens = used_tokens + ?, used_requests = used_requests + ?
             WHERE id = ? AND deleted_at IS NULL`,
          [billedTokens, billedRequests, userId],
        );
        // 周期档的计数存在 period_cycles JSON 里，SQL 无法直接按档累加，需读改写。
        // 与上面的总量累加同处一个事务，保证不会出现「总量已扣、周期未扣」的偏差。
        // 用户组档按每用户独立计数，这里取组定义一并累加到用户行，组档才能拦得住请求。
        const userGroupCycles = await loadUserGroupCycles(tx, userId);
        await accumulateCycles(tx, "users", userId, billedTokens, billedRequests, userGroupCycles);
      } else {
        await tx.execute(
          `UPDATE users
             SET used_tokens = used_tokens + ?, used_requests = used_requests + ?
             WHERE id = ? AND deleted_at IS NULL`,
          [billedTokens, billedRequests, userId],
        );
      }
    }

    await tx.execute(
      `UPDATE \`keys\`
         SET used_tokens = used_tokens + ?, used_requests = used_requests + ?, last_used_at = CURRENT_TIMESTAMP
         WHERE id = ? AND deleted_at IS NULL`,
      [billedTokens, billedRequests, keyId],
    );

    // 渠道/模型的 period_used_* 与用户侧不同：它是「总请求/总 Token 配额」
    // （quota_requests / quota_tokens，见 checkChannelQuota / checkModelQuota）的计数器，
    // 至今仍在生效且界面上可编辑，因此这里继续累加。
    // 渠道/模型的旧单档周期定义列（quota_period / period_quota_*）已停止写入，
    // 周期配额统一走 period_cycles。
    if (channelId != null && modelGateFeatures.periodQuota) {
      await tx.execute(
        `UPDATE channels
           SET period_used_tokens = period_used_tokens + ?, period_used_requests = period_used_requests + ?
           WHERE id = ? AND deleted_at IS NULL`,
        [billedTokens, billedRequests, channelId],
      );
      await accumulateCycles(tx, "channels", channelId, billedTokens, billedRequests);
    }

    if (modelId != null && modelGateFeatures.periodQuota) {
      await tx.execute(
        `UPDATE models
           SET period_used_tokens = period_used_tokens + ?, period_used_requests = period_used_requests + ?
           WHERE id = ? AND deleted_at IS NULL`,
        [billedTokens, billedRequests, modelId],
      );
      await accumulateCycles(tx, "models", modelId, billedTokens, billedRequests);
    }
  });
}

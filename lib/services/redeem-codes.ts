import { randomBytes } from "node:crypto";
import { gatewayDb } from "@/lib/core/db";
import type { ExecuteResult, TransactionContext } from "@/lib/core/db/adapter";
import { BusyError } from "@/lib/core/busy-error";
import { modelGateFeatures } from "@/lib/core/features";
import { toMysqlDatetime, parseStoredUtc } from "@/lib/core/db/datetime";
import { stringifyAllowedChannelIds } from "@/lib/gateway/channel-access";
import { stringifyAllowedModelAliases } from "@/lib/gateway/model-access";
import { parsePeriodCycles, serializePeriodCycles, serializePeriodCycleState, type PeriodCycle, type PeriodCycleInput } from "@/lib/gateway/period-cycles";
import { toPeriodQuotaEntry, findExceededCycle, type PeriodQuotaEntry } from "@/lib/gateway/quota";
import { buildRedeemScope, scopeCoversPair, balanceHasRemaining, ensureBalanceCycleResets } from "@/lib/services/redeem-authorization";
import type { CycleResetExecutor } from "@/lib/gateway/period-cycles-reset";

// 判断是否为唯一约束冲突（SQLite: UNIQUE constraint failed; MySQL: ER_DUP_ENTRY）。
function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /UNIQUE constraint failed|ER_DUP_ENTRY|duplicate entry/i.test(err.message ?? String(err));
}

// 用于在并发重复兑换时强制回滚事务，再由外层转为友好提示，避免多计一次核销次数。
class RedeemAlreadyRedeemedError extends Error {}

// 抢占核销次数失败（已停用、已过期、次数耗尽）时抛出，用于回滚事务内已写入的额度行。
class RedeemCodeExhaustedError extends Error {}

export type RedeemCodeRow = {
  id: number;
  code: string;
  batch_id: string;
  // quota 为额度券（发放定向额度），reset 为重置券（只清零周期用量，不发额度）。
  kind: "quota" | "reset";
  token_quota: number | null;
  request_quota: number | null;
  period_cycles: string | null;
  allowed_channel_ids: string;
  allowed_model_aliases: string;
  allowed_group_ids: string | null;
  expires_at: string | null;
  enabled: number;
  max_uses: number;
  used_count: number;
  note: string | null;
  created_by: number | null;
  created_at: string;
};

export type RedeemBalanceRow = {
  id: number;
  code_id: number;
  user_id: number;
  token_quota: number | null;
  request_quota: number | null;
  used_tokens: number;
  used_requests: number;
  period_cycles: string | null;
  allowed_channel_ids: string;
  allowed_model_aliases: string;
  expires_at: string | null;
  created_at: string;
};

// 周期档定义（兑换码上只存定义值，运行时计数存在 redeem_balances 里）。
export type { PeriodCycle, PeriodCycleInput, PeriodQuotaEntry };

export function parseAllowedGroupIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // 只认 number：true/false/null 等不再被 Number() 容错成 1/0，重复项直接去重。
    return [...new Set(parsed.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0))];
  } catch {
    return [];
  }
}

export function stringifyAllowedGroupIds(ids: number[]): string {
  const normalized = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
  return JSON.stringify(normalized);
}

export async function listExistingGroupIds(ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = await gatewayDb.query<{ id: number }>(`SELECT id FROM \`groups\` WHERE id IN (${placeholders}) AND deleted_at IS NULL`, ids);
  return rows.map((row) => row.id);
}

// 批量生成 N 个不重复兑换码，归入同一 batch_id。
export async function generateRedeemCodes(input: {
  count: number;
  // 额度券发放定向额度；重置券只清零周期用量，额度字段一律忽略。
  kind: "quota" | "reset";
  tokenQuota: number | null;
  requestQuota: number | null;
  periodCycles: PeriodCycleInput[];
  allowedChannelIds: number[];
  allowedModelAliases: string[];
  allowedGroupIds: number[];
  expiresAt: string | null;
  maxUses: number;
  note?: string;
  createdBy: number;
}): Promise<{ codes: string[]; batchId: string }> {
  const count = Math.min(1000, Math.max(1, Math.floor(input.count)));
  const batchId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const now = toMysqlDatetime(new Date());
  const isReset = input.kind === "reset";
  // 重置券不携带额度与周期档定义：它的语义是清空已有用量，不是新增限制。
  const periodCycles = isReset ? null : stringifyCycles(input.periodCycles);

  const codes: string[] = [];
  await gatewayDb.transaction(async (tx) => {
    for (let i = 0; i < count; i += 1) {
      let code = "";
      let attempts = 0;
      // 生成去重兑换码，最多重试 5 次避免碰撞
      while (attempts < 5) {
        const candidate = generateRedeemCode();
        const exists = await tx.queryOne<{ id: number }>(
          "SELECT id FROM redeem_codes WHERE code = ?",
          [candidate],
        );
        if (!exists) {
          code = candidate;
          break;
        }
        attempts += 1;
      }
      if (!code) throw new Error("兑换码生成失败，请重试");

      await tx.execute(
        `INSERT INTO redeem_codes (
           code, batch_id, kind, token_quota, request_quota, period_cycles,
           allowed_channel_ids, allowed_model_aliases, allowed_group_ids,
           expires_at, enabled, max_uses, used_count, note, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?)`,
        [
          code,
          batchId,
          input.kind,
          input.tokenQuota,
          input.requestQuota,
          periodCycles,
          stringifyAllowedChannelIds(input.allowedChannelIds),
          stringifyAllowedModelAliases(input.allowedModelAliases),
          stringifyAllowedGroupIds(input.allowedGroupIds),
          input.expiresAt ?? null,
          input.maxUses,
          input.note?.trim() || null,
          input.createdBy,
          now,
        ],
      );
      codes.push(code);
    }
  });

  return { codes, batchId };
}

// 兑换码上的周期档只存定义值；功能关闭时强制为空，避免精简版留下可生效的周期配置。
function stringifyCycles(cycles: PeriodCycleInput[]): string | null {
  if (!modelGateFeatures.periodQuota) return null;
  const serialized = serializePeriodCycles(cycles);
  return serialized || null;
}

function generateRedeemCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = randomBytes(12);
  for (let i = 0; i < 12; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  // 格式：XXXX-XXXX-XXXX
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

// 管理员输入的到期时间只接受 `YYYY-MM-DD`、`YYYY-MM-DD HH:MM[:SS]` 或带时区的 ISO 写法，
// 不带时区后缀时按存储约定解释为 UTC（与 parseStoredUtc 一致），`new Date` 那种把 "0"、"2026" 也收下的宽松解析不使用。
const EXPIRES_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const EXPIRES_INPUT_HINT = "有效期格式不正确，请使用 ISO 时间（如 2026-12-01T00:00:00Z）";
export const EXPIRES_FUTURE_HINT = "有效期需晚于当前时间；如需立即失效请停用该兑换码";

export function parseExpiresInput(raw: string): { ok: true; value: string; time: number } | { ok: false; reason: string } {
  const match = EXPIRES_INPUT_PATTERN.exec(raw.trim());
  if (!match) return { ok: false, reason: EXPIRES_INPUT_HINT };
  const [, year, month, day, hour, minute, second, milli, zone] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = hour === undefined ? 0 : Number(hour);
  const mi = minute === undefined ? 0 : Number(minute);
  const s = second === undefined ? 0 : Number(second);
  const ms = milli === undefined ? 0 : Number(milli.padEnd(3, "0"));
  // 先按字面年月日构造再校验，避免 2 月 30 日、24 点这类输入被 Date 自动进位成另一个时刻
  const base = new Date(Date.UTC(2000, mo - 1, d, h, mi, s, ms));
  base.setUTCFullYear(y);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59 || base.getUTCMonth() !== mo - 1 || base.getUTCDate() !== d) {
    return { ok: false, reason: EXPIRES_INPUT_HINT };
  }
  // 存储精度到秒，先截断再返回，保证调用方的时点判定与落库值、回读值一致
  const time = Math.floor((zone ? new Date(raw.trim()).getTime() : base.getTime()) / 1000) * 1000;
  const result = new Date(time);
  // 带偏移的输入会改变 UTC 年份，越界值落库后不可用（数据库拒写或比较恒假），这里按结果再校验一次
  if (Number.isNaN(time) || result.getUTCFullYear() < 1000 || result.getUTCFullYear() > 9999) {
    return { ok: false, reason: EXPIRES_INPUT_HINT };
  }
  return { ok: true, value: toMysqlDatetime(result), time };
}

// 存储的到期时间语义：null 为长期有效，解析不出来（历史数据里的空串、零日期）视为异常。
// 与授权、核销 SQL 的 `expires_at IS NULL OR expires_at > ?` 保持一致，避免「界面显示长期有效却永远核销不了」。
function resolveStoredExpiry(value: string | null | undefined): { kind: "none" } | { kind: "invalid" } | { kind: "at"; time: number } {
  if (value == null) return { kind: "none" };
  const parsed = parseStoredUtc(value);
  return parsed ? { kind: "at", time: parsed.getTime() } : { kind: "invalid" };
}

export function isCodeValid(row: Pick<RedeemCodeRow, "enabled" | "expires_at" | "max_uses" | "used_count">): { ok: boolean; reason?: string } {
  if (row.enabled !== 1) {
    return { ok: false, reason: "该兑换码已停用" };
  }
  if (row.max_uses !== 0 && row.used_count >= row.max_uses) {
    return { ok: false, reason: "该兑换码使用次数已达上限" };
  }
  const expiry = resolveStoredExpiry(row.expires_at);
  if (expiry.kind === "invalid") {
    return { ok: false, reason: "该兑换码有效期数据异常，请联系管理员" };
  }
  if (expiry.kind === "at" && expiry.time <= Date.now()) {
    return { ok: false, reason: "该兑换码已过期" };
  }
  return { ok: true };
}

export type RedeemCodeListRow = RedeemCodeRow & {
  created_by_username: string | null;
  redeemed_users: number;
  used_tokens_sum: number;
  used_requests_sum: number;
};

// 管理员列表用的聚合查询：LEFT JOIN 创建人用户名 + 聚合持有人数与已用额度。
// 用 GROUP BY rc.id 而不是 JOIN 后直接分页，避免一个码对应多条 balance 时把行数放大导致 total 失准。
// redeemed_users 的统计口径与 redeem-authorization 的行为保持一致：只数「当前仍有效」的额度，
// 已用尽/已过期/所属兑换码已停用的都不算，否则列表上会显示成还有人持有。
// 周期档的耗尽依赖 JSON 列，无法在 SQL 里判定，故先取出金额与周期列，再在 JS 侧用同一口径过滤。
const CODE_LIST_SELECT = `SELECT rc.*,
         cu.username AS created_by_username,
         COALESCE(SUM(b.used_tokens), 0) AS used_tokens_sum,
         COALESCE(SUM(b.used_requests), 0) AS used_requests_sum
    FROM redeem_codes rc
    LEFT JOIN users cu ON cu.id = rc.created_by
    LEFT JOIN redeem_balances b ON b.code_id = rc.id`;

const CODE_LIST_BALANCE_SELECT = `SELECT rc.id AS code_id,
         b.id, b.token_quota, b.request_quota, b.used_tokens, b.used_requests,
         b.expires_at, b.period_cycles, rc.enabled AS code_enabled
    FROM redeem_codes rc
    LEFT JOIN redeem_balances b ON b.code_id = rc.id`;

// 统计每个兑换码当前仍有效的持有人数。判定与授权/计费侧完全一致（含周期档）。
async function countActiveHolders(codeIds: number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (codeIds.length === 0) return counts;
  const placeholders = codeIds.map(() => "?").join(",");
  const rows = await gatewayDb.query<{
    code_id: number;
    id: number | null;
    token_quota: number | null;
    request_quota: number | null;
    used_tokens: number;
    used_requests: number;
    expires_at: string | null;
    period_cycles: string | null;
    code_enabled: number;
  }>(
    `${CODE_LIST_BALANCE_SELECT} WHERE rc.id IN (${placeholders})`,
    codeIds,
  );
  const now = Date.now();
  for (const row of rows) {
    if (row.id === null) continue;
    if (row.code_enabled !== 1) continue;
    const expiry = resolveStoredExpiry(row.expires_at);
    if (expiry.kind === "invalid") continue;
    if (expiry.kind === "at" && expiry.time <= now) continue;
    if (!balanceHasRemaining(row)) continue;
    counts.set(row.code_id, (counts.get(row.code_id) ?? 0) + 1);
  }
  return counts;
}

// 给列表行补齐 redeemed_users（SQL 里已无法承担周期判定）。
async function attachActiveHolders<T extends { id: number }>(rows: T[]): Promise<Array<T & { redeemed_users: number }>> {
  const counts = await countActiveHolders(rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, redeemed_users: counts.get(row.id) ?? 0 }));
}

export async function getCodeByCode(code: string): Promise<RedeemCodeRow | undefined> {
  return gatewayDb.queryOne<RedeemCodeRow>(
    "SELECT * FROM redeem_codes WHERE code = ?",
    [code.trim().toUpperCase()],
  );
}

export async function getCodeById(id: number): Promise<RedeemCodeRow | undefined> {
  return gatewayDb.queryOne<RedeemCodeRow>("SELECT * FROM redeem_codes WHERE id = ?", [id]);
}

// 批量启用/停用，返回实际影响行数（不存在的兑换码被忽略）。
export async function setRedeemCodesEnabled(codes: string[], enabled: boolean): Promise<number> {
  if (codes.length === 0) return 0;
  const placeholders = codes.map(() => "?").join(",");
  const result = await gatewayDb.execute(
    `UPDATE redeem_codes SET enabled = ? WHERE code IN (${placeholders})`,
    [enabled ? 1 : 0, ...codes],
  );
  return result.changes;
}

// 按批次批量启用/停用，返回该批次内的兑换码数量；批次不存在时返回 0。
// 停用即召回：授权与计费侧都按 redeem_codes.enabled 过滤，已发放但未用完的定向额度会同时失效。
export async function setRedeemBatchEnabled(batchId: string, enabled: boolean): Promise<number> {
  return gatewayDb.transaction(async (tx) => {
    // 先更新再判断存在性：SQLite 与 mysql2 默认配置（CLIENT_FOUND_ROWS）下 changes 是匹配行数，
    // 只有零匹配才需要再查一次；若驱动未启用 FOUND_ROWS，零 changes 也可能是「全部已是目标状态」，
    // 因此用 COUNT 同时兜底这两种情况。
    const result = await tx.execute(
      "UPDATE redeem_codes SET enabled = ? WHERE batch_id = ?",
      [enabled ? 1 : 0, batchId],
    );
    if (result.changes > 0) return result.changes;
    const row = await tx.queryOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM redeem_codes WHERE batch_id = ?",
      [batchId],
    );
    return row?.total ?? 0;
  });
}

// 批量删除兑换码及其定向额度与核销记录，返回实际删除数量。
export async function deleteRedeemCodes(codes: string[]): Promise<number> {
  if (codes.length === 0) return 0;
  const placeholders = codes.map(() => "?").join(",");
  const ids = (await gatewayDb.query<{ id: number }>(
    `SELECT id FROM redeem_codes WHERE code IN (${placeholders})`,
    codes,
  )).map((row) => row.id);
  if (ids.length === 0) return 0;

  try {
    await gatewayDb.transaction(async (tx) => {
      const idPlaceholders = ids.map(() => "?").join(",");
      // 加锁顺序与兑换事务保持一致（额度 → 核销记录 → 兑换码），避免与并发兑换构成死锁环
      await tx.execute(`DELETE FROM redeem_balances WHERE code_id IN (${idPlaceholders})`, ids);
      await tx.execute(`DELETE FROM redeem_redemptions WHERE code_id IN (${idPlaceholders})`, ids);
      await tx.execute(`DELETE FROM redeem_codes WHERE id IN (${idPlaceholders})`, ids);
    });
  } catch (err) {
    throw mapLockConflict(err);
  }
  return ids.length;
}

// 按批次删除兑换码及其定向额度与核销记录，返回删除数量；批次不存在时返回 0。
// code_id 先在事务外物化，避免事务内的子查询先锁住 redeem_codes 造成加锁顺序反转。
export async function deleteRedeemBatch(batchId: string): Promise<number> {
  // 先把 code_id 物化出来：事务内用子查询会先给 redeem_codes 加 S 锁，
  // 变成「兑换码 → 额度」的反向顺序，与并发兑换构成死锁环。
  const ids = (await gatewayDb.query<{ id: number }>(
    "SELECT id FROM redeem_codes WHERE batch_id = ?",
    [batchId],
  )).map((row) => row.id);
  if (ids.length === 0) return 0;

  try {
    return await gatewayDb.transaction(async (tx) => {
      const idPlaceholders = ids.map(() => "?").join(",");
      // 加锁顺序与兑换事务保持一致（额度 → 核销记录 → 兑换码）
      await tx.execute(`DELETE FROM redeem_balances WHERE code_id IN (${idPlaceholders})`, ids);
      await tx.execute(`DELETE FROM redeem_redemptions WHERE code_id IN (${idPlaceholders})`, ids);
      const result = await tx.execute(`DELETE FROM redeem_codes WHERE id IN (${idPlaceholders})`, ids);
      return result.changes;
    });
  } catch (err) {
    throw mapLockConflict(err);
  }
}

// 用户兑换：校验有效性、限定渠道/模型是否存在，创建定向额度并登记核销。
// 兑换结果：额度券返回新建的定向额度，重置券不发额度（balance 为 null）。
export type RedeemResult =
  | { ok: true; balance: RedeemBalanceRow }
  | { ok: true; balance: null; reset: true }
  | { ok: false; reason: string };

// 重置券核销：把该用户的周期用量全部清零，周期重新起算。
// 自有档（users.period_cycles）与继承自组的档位（users.group_period_cycles）分别归零，
// 两者的定义与秒数保持不变，因此不会影响组配置的继承关系。
async function resetUserCycleUsage(tx: CycleResetExecutor, userId: number): Promise<void> {
  const row = await tx.queryOne<{ period_cycles: string | null; group_period_cycles: string | null }>(
    "SELECT period_cycles, group_period_cycles FROM users WHERE id = ?",
    [userId],
  );
  if (!row) return;
  const clear = (raw: string | null) => {
    const cycles = parsePeriodCycles(raw);
    if (cycles.length === 0) return null;
    return serializePeriodCycleState(cycles.map((cycle) => ({
      ...cycle,
      used_tokens: 0,
      used_requests: 0,
      reset_at: null,
    })));
  };
  await tx.execute(
    "UPDATE users SET period_cycles = ?, group_period_cycles = ? WHERE id = ?",
    [clear(row.period_cycles), clear(row.group_period_cycles), userId],
  );
}

// 原子抢占一次核销次数。必须放在事务最后一步：同一兑换码的并发事务只在这一行上排队，
// 持锁范围从「整段读写」压缩到「一条 UPDATE」，量化后单行吞吐提升一个数量级。
async function claimRedeemUse(tx: TransactionContext, codeId: number): Promise<void> {
  const updated = await tx.execute(
    `UPDATE redeem_codes
       SET used_count = used_count + 1
       WHERE id = ? AND enabled = 1
         AND (max_uses = 0 OR used_count < max_uses)
         AND (expires_at IS NULL OR expires_at > ?)`,
    [codeId, toMysqlDatetime(new Date())],
  );
  if (updated.changes !== 1) throw new RedeemCodeExhaustedError();
}

// 事务内只做写入与冲突判定，额度行在抢占 used_count 之前读回：
// 提交后再取一次连接读取，会在池已饱和时出现「次数已扣、响应却 500」。
type RedeemTxOutcome =
  | { kind: "quota"; balance: RedeemBalanceRow }
  | { kind: "reset" }
  | { kind: "rejected"; reason: string };

// 1213/1205 属于锁冲突而非业务拒绝：兑换与管理员改码/删码并发时会撞上，
// 重试一次即可避开，重试仍失败则按繁忙返回，不向用户抛 500。
function isLockConflictError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: string }).code;
  if (code === "ER_LOCK_DEADLOCK" || code === "ER_LOCK_WAIT_TIMEOUT") return true;
  return /Deadlock found|Lock wait timeout exceeded|database is locked/i.test(err.message ?? "");
}

// 锁冲突后的重试预算：立即重试只会再排一次队，先退避一小段；
// 若首次尝试已经把预算耗尽则不再重试，避免单个请求耗时叠加到反代超时线以上。
const REDEEM_DEADLINE_MS = 8_000;
const REDEEM_RETRY_DELAY_MS = 20;

// 管理员侧同样可能与并发兑换撞上行锁冲突，映射成可读文案而不是抛 500 英文错误。
function mapLockConflict(err: unknown): Error {
  if (isLockConflictError(err)) return new BusyError();
  return err instanceof Error ? err : new Error(String(err));
}

async function runRedeemTransaction(
  fn: (tx: TransactionContext) => Promise<RedeemTxOutcome>,
  deadlineAt: number,
): Promise<RedeemTxOutcome> {
  try {
    return await gatewayDb.transaction(fn);
  } catch (err) {
    if (!isLockConflictError(err)) throw err;
    // SQLite 是同步驱动，重试只会把单进程再卡一个 busy_timeout（默认 30s），
    // 比直接失败更糟，因此只在 MySQL 下重试。
    if ((await gatewayDb.getDriver()) !== "mysql") throw err;
    const jitter = REDEEM_RETRY_DELAY_MS + Math.floor(Math.random() * REDEEM_RETRY_DELAY_MS);
    if (Date.now() + jitter >= deadlineAt) throw err;
    await new Promise((resolve) => setTimeout(resolve, jitter));
    return gatewayDb.transaction(fn);
  }
}

export async function redeemCodeForUser(userId: number, code: string): Promise<RedeemResult> {
  const normalized = code.trim().toUpperCase();
  const row = await getCodeByCode(normalized);
  if (!row) {
    return { ok: false, reason: "兑换码不存在" };
  }

  const validity = isCodeValid(row);
  if (!validity.ok) {
    return { ok: false, reason: validity.reason ?? "兑换码不可用" };
  }

  const allowedGroupIds = parseAllowedGroupIds(row.allowed_group_ids);
  if (allowedGroupIds.length > 0) {
    const user = await gatewayDb.queryOne<{ group_id: number | null }>(
      "SELECT group_id FROM users WHERE id = ?",
      [userId],
    );
    if (user?.group_id == null || !allowedGroupIds.includes(user.group_id)) {
      return { ok: false, reason: "该兑换码仅限指定用户组兑换" };
    }
  }

  const deadlineAt = Date.now() + REDEEM_DEADLINE_MS;
  let outcome: RedeemTxOutcome;
  try {
    outcome = await runRedeemTransaction(async (tx): Promise<RedeemTxOutcome> => {
      // 重置券与额度分开：不发额度、不建 redeem_balances，只把核销人的周期用量清零。
      if (row.kind === "reset") {
        // 重置券不建额度行，因此不能用 redeem_balances 判重，改查核销记录。
        const redeemed = await tx.queryOne<{ id: number }>(
          "SELECT id FROM redeem_redemptions WHERE code_id = ? AND user_id = ?",
          [row.id, userId],
        );
        if (redeemed) {
          return { kind: "rejected", reason: "您已兑换过该兑换码" };
        }
        try {
          await tx.execute(
            "INSERT INTO redeem_redemptions (code_id, user_id, redeemed_at) VALUES (?, ?, ?)",
            [row.id, userId, toMysqlDatetime(new Date())],
          );
        } catch (err) {
          // 并发下同一用户重复核销，唯一约束兜底；抛出以回滚事务内的写入。
          if (isUniqueConstraintError(err)) throw new RedeemAlreadyRedeemedError();
          throw err;
        }
        // 先抢热点行再改 users：等锁期间不持有用户的周期行锁，
        // 避免把兑换码的排队时间放大到计费路径上。
        await claimRedeemUse(tx, row.id);
        await resetUserCycleUsage(tx, userId);
        return { kind: "reset" };
      }

      const existing = await tx.queryOne<{ id: number }>(
        "SELECT id FROM redeem_balances WHERE code_id = ? AND user_id = ?",
        [row.id, userId],
      );
      if (existing) {
        return { kind: "rejected", reason: "您已兑换过该兑换码" };
      }

      // 并发下同一用户重复兑换同一多用途兑换码时，SELECT 无法兜底，
      // 唯一约束会让后到事务抛错。捕获唯一约束冲突并转为友好提示。
      let balanceResult: ExecuteResult;
      try {
        balanceResult = await tx.execute(
          `INSERT INTO redeem_balances (
             code_id, user_id, token_quota, request_quota, period_cycles,
             allowed_channel_ids, allowed_model_aliases, expires_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            userId,
            row.token_quota,
            row.request_quota,
            // 周期档快照到额度上：兑换码之后被删除或改动都只影响新兑换，
            // 已发放额度的周期约束保持兑换时的形态（与额度、有效期一致）。
            modelGateFeatures.periodQuota ? row.period_cycles : null,
            row.allowed_channel_ids,
            row.allowed_model_aliases,
            row.expires_at,
            toMysqlDatetime(new Date()),
          ],
        );
      } catch (err) {
        if (isUniqueConstraintError(err)) throw new RedeemAlreadyRedeemedError();
        throw err;
      }

      try {
        await tx.execute(
          `INSERT INTO redeem_redemptions (code_id, user_id) VALUES (?, ?)`,
          [row.id, userId],
        );
      } catch (err) {
        if (isUniqueConstraintError(err)) throw new RedeemAlreadyRedeemedError();
        throw err;
      }

      // 在抢占 used_count 之前读回额度行：此时只持有本事务刚插入行的锁，
      // 不会延长 redeem_codes 的持锁时间，也不需要提交后再取一次连接。
      const balance = await tx.queryOne<RedeemBalanceRow>(
        "SELECT * FROM redeem_balances WHERE id = ?",
        [balanceResult.lastInsertRowid],
      );
      if (!balance) throw new Error("兑换额度写入后读取失败");

      await claimRedeemUse(tx, row.id);
      return { kind: "quota", balance };
    }, deadlineAt);
  } catch (err) {
    if (err instanceof RedeemAlreadyRedeemedError) {
      return { ok: false, reason: "您已兑换过该兑换码" };
    }
    if (err instanceof RedeemCodeExhaustedError) {
      return { ok: false, reason: "该兑换码已失效或使用次数已达上限" };
    }
    if (isLockConflictError(err)) {
      return { ok: false, reason: "兑换请求过于繁忙，请稍后重试" };
    }
    throw err;
  }

  if (outcome.kind === "rejected") {
    return { ok: false, reason: outcome.reason };
  }
  if (outcome.kind === "reset") {
    return { ok: true, balance: null, reset: true };
  }
  return { ok: true, balance: outcome.balance };
}

// 查询用户所有定向额度，有效性判定与授权、计费侧保持一致：兑换码启用、未过期、额度未耗尽（含周期档）。
// 停用码的额度在网关侧已不再授权，这里同样不算有效，否则界面会对拿不到权限的额度显示「有效」。
export async function listUserBalances(
  userId: number,
): Promise<Array<RedeemBalanceRow & {
  remaining_tokens: number | null;
  remaining_requests: number | null;
  periods: PeriodQuotaEntry[];
  active: boolean;
  inactive_reason: string | null;
}>> {
  const rows = await gatewayDb.query<RedeemBalanceRow & { code_enabled: number | null }>(
    `SELECT b.*, c.enabled AS code_enabled
       FROM redeem_balances b
       LEFT JOIN redeem_codes c ON c.id = b.code_id
      WHERE b.user_id = ?
      ORDER BY b.id DESC`,
    [userId],
  );
  const now = Date.now();
  // 先推进已到期的周期窗口：否则上个周期用尽的额度会一直被标记为「已用尽」。
  if (modelGateFeatures.periodQuota) {
    for (const row of rows) {
      await ensureBalanceCycleResets(row);
    }
  }
  return rows.map(({ code_enabled: codeEnabled, ...row }) => {
    const remainingTokens = row.token_quota !== null ? Math.max(0, row.token_quota - row.used_tokens) : null;
    const remainingRequests = row.request_quota !== null ? Math.max(0, row.request_quota - row.used_requests) : null;
    const periods = modelGateFeatures.periodQuota ? parsePeriodCycles(row.period_cycles) : [];
    const expiry = resolveStoredExpiry(row.expires_at);
    let inactiveReason: string | null = null;
    if (codeEnabled === null) inactiveReason = "来源兑换码缺失";
    else if (codeEnabled !== 1) inactiveReason = "兑换码已停用";
    else if (expiry.kind === "invalid") inactiveReason = "有效期数据异常";
    else if (expiry.kind === "at" && expiry.time <= now) inactiveReason = "已过期";
    else if (remainingTokens !== null && remainingTokens <= 0) inactiveReason = "Token 额度已用尽";
    else if (remainingRequests !== null && remainingRequests <= 0) inactiveReason = "请求额度已用尽";
    else {
      // 周期档的耗尽口径与授权侧 balanceHasRemaining 一致，都走 findExceededCycle
      const exceeded = findExceededCycle(periods, 0);
      if (exceeded) inactiveReason = exceeded.reason;
    }
    return {
      ...row,
      remaining_tokens: remainingTokens,
      remaining_requests: remainingRequests,
      periods: periods.map(toPeriodQuotaEntry),
      active: inactiveReason === null,
      inactive_reason: inactiveReason,
    };
  });
}

// 网关侧：查找匹配当前渠道+模型的用户有效定向额度。
// 与授权侧（redeem-authorization）共用同一有效性条件：兑换码启用、未过期、额度未耗尽，避免停用后计费仍命中。
export async function findMatchingRedeemBalance(userId: number, channelId: number | null, modelAlias: string | null): Promise<RedeemBalanceRow | null> {
  if (channelId === null || !modelAlias) return null;
  const now = toMysqlDatetime(new Date());
  const rows = await gatewayDb.query<RedeemBalanceRow>(
    `SELECT b.*
       FROM redeem_balances b
       JOIN redeem_codes c ON c.id = b.code_id
       WHERE b.user_id = ?
         AND c.enabled = 1
         AND (b.expires_at IS NULL OR b.expires_at > ?)
         AND (b.token_quota IS NULL OR b.used_tokens < b.token_quota)
         AND (b.request_quota IS NULL OR b.used_requests < b.request_quota)
       ORDER BY b.id`,
    [userId, now],
  );
  for (const row of rows) {
    // 先推进已到期的周期窗口，再判定是否覆盖本次请求。
    if (modelGateFeatures.periodQuota) await ensureBalanceCycleResets(row);
    // 周期档耗尽时该额度不再覆盖本次请求（否则会跳过全局配额检查造成超额）。
    if (!balanceHasRemaining(row)) continue;
    // 与授权侧的配对判定共用同一份逻辑，避免两处规则漂移。
    if (scopeCoversPair(buildRedeemScope(row.allowed_channel_ids, row.allowed_model_aliases), channelId, modelAlias)) {
      return row;
    }
  }
  return null;
}

// 管理员：按批次查看兑换码列表，附带创建人、当前有效持有人数与已用额度聚合。
export async function listCodes(options: { keyword?: string; limit: number; offset: number; batchId?: string }) {
  const { keyword = "", limit, offset, batchId } = options;
  const whereParts: string[] = [];
  const args: Array<string | number> = [];
  if (keyword) {
    whereParts.push("rc.code LIKE ?");
    args.push(`%${keyword.toUpperCase()}%`);
  }
  if (batchId) {
    whereParts.push("rc.batch_id = ?");
    args.push(batchId);
  }
  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
  const rows = await gatewayDb.query<Omit<RedeemCodeListRow, "redeemed_users">>(
    `${CODE_LIST_SELECT} ${whereSql} GROUP BY rc.id ORDER BY rc.id DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );
  const totalRow = await gatewayDb.queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total FROM redeem_codes rc ${whereSql}`,
    args,
  );
  return {
    data: await attachActiveHolders(rows),
    total: totalRow?.total ?? 0,
  };
}

// 管理员：取单个兑换码的汇总详情（创建人 + 聚合用量）。
export async function getCodeDetail(id: number): Promise<RedeemCodeListRow | undefined> {
  const row = await gatewayDb.queryOne<Omit<RedeemCodeListRow, "redeemed_users">>(
    `${CODE_LIST_SELECT} WHERE rc.id = ? GROUP BY rc.id`,
    [id],
  );
  if (!row) return undefined;
  const [withHolders] = await attachActiveHolders([row]);
  return withHolders;
}

export type UpdateRedeemCodeInput = {
  note?: string | null;
  enabled?: boolean;
  expiresAt?: string | null;
  maxUses?: number;
  tokenQuota?: number | null;
  requestQuota?: number | null;
  allowedGroupIds?: number[];
};

// 管理员编辑单个兑换码。遵循「只增不减」：额度类字段只允许上调，
// max_uses 只允许放宽（0 视为不限，属最宽），避免收紧后已兑换用户凭空失效。
// 有效期收紧时不得早于任一已发放额度的过期时间（NULL 表示长期有效，不能收紧为有限期）。
export async function updateRedeemCode(
  id: number,
  input: UpdateRedeemCodeInput,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await getCodeById(id);
  if (!row) return { ok: false, reason: "兑换码不存在" };

  const sets: string[] = [];
  const args: Array<string | number | null> = [];

  if (input.note !== undefined) {
    sets.push("note = ?");
    args.push(input.note === null ? null : input.note.trim() || null);
  }

  if (input.enabled !== undefined) {
    sets.push("enabled = ?");
    args.push(input.enabled ? 1 : 0);
  }

  if (input.allowedGroupIds !== undefined) {
    sets.push("allowed_group_ids = ?");
    args.push(stringifyAllowedGroupIds(input.allowedGroupIds));
  }

  if (input.maxUses !== undefined) {
    if (input.maxUses !== 0 && row.max_uses !== 0 && input.maxUses < row.max_uses) {
      return { ok: false, reason: "最多兑换次数只能放宽，不能收紧" };
    }
    if (input.maxUses !== 0 && input.maxUses < row.used_count) {
      return { ok: false, reason: `该兑换码已被兑换 ${row.used_count} 次，最多兑换次数不能小于该值` };
    }
    sets.push("max_uses = ?");
    args.push(input.maxUses);
  }

  if (input.tokenQuota !== undefined) {
    if (input.tokenQuota === null && row.token_quota !== null) {
      return { ok: false, reason: "Token 额度不能改为不限；如需放宽到不限请停用旧码并重新生成" };
    }
    if (input.tokenQuota !== null && row.token_quota !== null && input.tokenQuota < row.token_quota) {
      return { ok: false, reason: "Token 额度只能上调，不能下调；如需下调请停用旧码并重新生成" };
    }
    sets.push("token_quota = ?");
    args.push(input.tokenQuota);
  }

  if (input.requestQuota !== undefined) {
    if (input.requestQuota === null && row.request_quota !== null) {
      return { ok: false, reason: "请求额度不能改为不限；如需放宽到不限请停用旧码并重新生成" };
    }
    if (input.requestQuota !== null && row.request_quota !== null && input.requestQuota < row.request_quota) {
      return { ok: false, reason: "请求额度只能上调，不能下调；如需下调请停用旧码并重新生成" };
    }
    sets.push("request_quota = ?");
    args.push(input.requestQuota);
  }

  if (input.expiresAt !== undefined) {
    if (input.expiresAt === null) {
      // NULL 会被核销 SQL 的 `expires_at IS NULL OR expires_at > ?` 豁免过期判定，
      // 允许改成 NULL 等于给该码开永久有效口子，故只允许延长、不允许清空。
      return { ok: false, reason: "有效期不能为空；如需永久有效请重新生成兑换码" };
    }
    const next = parseStoredUtc(input.expiresAt);
    if (!next) return { ok: false, reason: EXPIRES_INPUT_HINT };
    // 设为已经过去的时刻只会得到一个立刻失效的码，没有可兑换窗口。
    if (next.getTime() <= Date.now()) return { ok: false, reason: EXPIRES_FUTURE_HINT };
    const current = row.expires_at ? parseStoredUtc(row.expires_at) : null;
    if (current && next.getTime() < current.getTime()) {
      return { ok: false, reason: "有效期只能延长，不能缩短；如需缩短请停用该兑换码" };
    }
    // 所有已发放额度的过期时间都要放宽到新有效期之后：
    // 只看一条（LIMIT 1）会漏掉过期时间更晚的其他额度，导致它们凭空提前失效。
    const issued = await gatewayDb.query<{ expires_at: string | null }>(
      "SELECT expires_at FROM redeem_balances WHERE code_id = ?",
      [id],
    );
    if (issued.some((b) => resolveStoredExpiry(b.expires_at).kind === "none")) {
      return { ok: false, reason: "已有用户兑换该码且额度长期有效，无法为其设置有效期" };
    }
    // 解析不出来的额度无法参与下面的比较，若它的值在 SQL 比较下仍算未过期，改小就成了静默缩短
    if (issued.some((b) => resolveStoredExpiry(b.expires_at).kind === "invalid")) {
      return { ok: false, reason: "已有用户兑换该码且额度有效期数据异常，请先处理该额度" };
    }
    for (const balance of issued) {
      const issuedExpires = balance.expires_at ? parseStoredUtc(balance.expires_at) : null;
      if (issuedExpires && next.getTime() < issuedExpires.getTime()) {
        return { ok: false, reason: "有效期不能早于已发放额度的过期时间" };
      }
    }
    sets.push("expires_at = ?");
    args.push(input.expiresAt);
  }

  if (sets.length === 0) return { ok: false, reason: "没有需要更新的字段" };

  // 原样应用到已发放额度：只放宽不收紧，不会让已兑换用户的余量变小。
  const balanceSets: string[] = [];
  const balanceArgs: Array<string | number | null> = [];
  if (input.tokenQuota !== undefined) {
    balanceSets.push("token_quota = ?");
    balanceArgs.push(input.tokenQuota);
  }
  if (input.requestQuota !== undefined) {
    balanceSets.push("request_quota = ?");
    balanceArgs.push(input.requestQuota);
  }
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    balanceSets.push("expires_at = ?");
    balanceArgs.push(input.expiresAt);
  }

  try {
    await gatewayDb.transaction(async (tx) => {
      // 加锁顺序与兑换事务保持一致（额度 → 兑换码），避免与并发兑换构成死锁环
      if (balanceSets.length > 0) {
        await tx.execute(
          `UPDATE redeem_balances SET ${balanceSets.join(", ")} WHERE code_id = ?`,
          [...balanceArgs, id],
        );
      }
      await tx.execute(`UPDATE redeem_codes SET ${sets.join(", ")} WHERE id = ?`, [...args, id]);
    });
  } catch (err) {
    throw mapLockConflict(err);
  }

  return { ok: true };
}

// 管理员：查看某批次的核销/兑换记录。
export async function listRedemptions(options: { codeId?: number; userId?: number; limit: number; offset: number }) {
  const { codeId, userId, limit, offset } = options;
  const whereParts: string[] = [];
  const args: Array<string | number> = [];
  if (codeId) {
    whereParts.push("r.code_id = ?");
    args.push(codeId);
  }
  if (userId) {
    whereParts.push("r.user_id = ?");
    args.push(userId);
  }
  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
  const rows = await gatewayDb.query<Record<string, unknown>>(
    `SELECT r.id, r.code_id, r.user_id, r.redeemed_at, c.code, u.username,
            b.token_quota, b.request_quota, b.used_tokens, b.used_requests, b.expires_at, b.period_cycles
       FROM redeem_redemptions r
       LEFT JOIN redeem_codes c ON c.id = r.code_id
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN redeem_balances b ON b.code_id = r.code_id AND b.user_id = r.user_id
       ${whereSql}
       ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );
  const totalRow = await gatewayDb.queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total FROM redeem_redemptions r ${whereSql}`,
    args,
  );
  return { data: rows, total: totalRow?.total ?? 0 };
}

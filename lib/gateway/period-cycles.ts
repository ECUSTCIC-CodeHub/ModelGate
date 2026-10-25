import { parseStoredUtc, toMysqlDatetime } from "@/lib/core/db/datetime";

// 一个重置周期档位。used_* 与 reset_at 是运行时状态，随定义值一同落库在 period_cycles 里。
//
// quota_* 三态（全链路口径一致）：
// - null  = 继承上游（用户上继承用户组，其余对象没有上游即不限制）
// - -1    = 显式不限制，覆盖上游（用户档上的 -1 表示该周期不受用户组同秒数档位约束）
// - >= 0  = 该周期的额度
export type PeriodCycle = {
  id: string;
  seconds: number;
  quota_tokens: number | null;
  quota_requests: number | null;
  used_tokens: number;
  used_requests: number;
  reset_at: string | null;
};

// 管理员提交的定义值：不含运行时状态。
export type PeriodCycleInput = {
  id?: string;
  seconds: number;
  quota_tokens: number | null;
  quota_requests: number | null;
};

export const MAX_PERIOD_CYCLES = 8;
export const MIN_PERIOD_SECONDS = 60;
// 100 年。上限用于挡住「秒数写成天文数字导致 reset_at 溢出 DATETIME」的输入。
export const MAX_PERIOD_SECONDS = 3153600000;

export function isValidPeriodSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_PERIOD_SECONDS && value <= MAX_PERIOD_SECONDS;
}

// used_* 只由计费侧自增产生，不接受外部输入，因此这里不做上限夹取；
// 上限只需在 cleanQuota 里挡住管理员提交的额度值。
function cleanCount(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
}

// -1 是「显式不限制」的哨兵值，必须原样保留；其余负数一律视为未配置（继承）。
function cleanQuota(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num === -1) return -1;
  if (num < 0) return null;
  // 夹到安全整数范围：超出 BIGINT 的值会在落库时变成原始 DB 错误而不是 400。
  return Math.min(Math.round(num), Number.MAX_SAFE_INTEGER);
}

// 提交体里的额度只接受 null / undefined / 整数（-1 与 >= 0）。
// 不做隐式数字转换：JSON 里的 "1000" 多半是调用方拼错了类型。
function isQuotaInput(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "number") return false;
  return Number.isInteger(value) && (value === -1 || value >= 0);
}

// 档位 id 仅在单对象内唯一，用于响应头与前端定位；缺省时按序生成，保证稳定。
function normalizeId(raw: unknown, index: number, seen: Set<string>): string {
  const candidate = typeof raw === "string" ? raw.trim() : "";
  const base = /^[A-Za-z0-9_-]{1,32}$/.test(candidate) ? candidate : `p${index + 1}`;
  if (!seen.has(base)) {
    seen.add(base);
    return base;
  }
  let suffix = 2;
  while (seen.has(`${base}_${suffix}`)) suffix += 1;
  const unique = `${base}_${suffix}`;
  seen.add(unique);
  return unique;
}

type ParsedCycleShape = {
  seconds: number;
  quota_tokens: number | null;
  quota_requests: number | null;
  used_tokens: number;
  used_requests: number;
  reset_at: string | null;
};

// 统一的数组解析：既接受库里的 JSON 字符串，也接受调用方直接传入的数组。
// 静默丢弃非法档位而不是整体报错，避免一条坏数据让整个对象失去配额约束。
function parseCycleArray(raw: unknown): ParsedCycleShape[] {
  let value = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      value = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];

  const out: ParsedCycleShape[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (!isValidPeriodSeconds(record.seconds)) continue;
    const resetAtRaw = typeof record.reset_at === "string" ? record.reset_at.trim() : "";
    // reset_at 一律归一成裸 UTC 字符串：库里可能残留 RFC3339 带 T/Z 的旧格式，
    // 外泄会让下游继续踩字典序比较的坑（见 ensureCycleResets 注释）。
    const parsedReset = resetAtRaw ? parseStoredUtc(resetAtRaw) : null;
    out.push({
      seconds: record.seconds,
      quota_tokens: cleanQuota(record.quota_tokens),
      quota_requests: cleanQuota(record.quota_requests),
      used_tokens: cleanCount(record.used_tokens),
      used_requests: cleanCount(record.used_requests),
      reset_at: parsedReset ? toMysqlDatetime(parsedReset) : null,
    });
    if (out.length >= MAX_PERIOD_CYCLES) break;
  }
  return out;
}

// 读取已有档位（保留 id 与运行时状态）。
export function parsePeriodCycles(raw: unknown): PeriodCycle[] {
  let value = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      value = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];

  const ids: string[] = [];
  for (const item of value) {
    if (item && typeof item === "object") {
      ids.push(typeof (item as Record<string, unknown>).id === "string" ? String((item as Record<string, unknown>).id) : "");
    } else {
      ids.push("");
    }
  }

  const parsed = parseCycleArray(raw);
  const seen = new Set<string>();
  return parsed.map((cycle, index) => ({ id: normalizeId(ids[index], index, seen), ...cycle }));
}

// 定义值 → 带运行时状态的档位（初始计数为 0）。
// id 缺省时按秒数生成：空串会写出 `...-Remaining-` 这种无名响应头，前端列表也会撞 key。
export function toCycleFromInput(input: PeriodCycleInput, id?: string, fallbackId?: string): PeriodCycle {
  return {
    id: typeof id === "string" && id !== "" ? id : input.id || fallbackId || `p${input.seconds}`,
    seconds: input.seconds,
    quota_tokens: input.quota_tokens,
    quota_requests: input.quota_requests,
    used_tokens: 0,
    used_requests: 0,
    reset_at: null,
  };
}

// 定义值序列化（丢弃运行时状态），用于写入对象自身的 period_cycles 配置。
export function serializePeriodCycles(cycles: PeriodCycleInput[]): string {
  const seen = new Set<string>();
  const normalized = cycles.slice(0, MAX_PERIOD_CYCLES).map((cycle, index) => ({
    id: normalizeId(cycle.id, index, seen),
    seconds: cycle.seconds,
    quota_tokens: cleanQuota(cycle.quota_tokens),
    quota_requests: cleanQuota(cycle.quota_requests),
  }));
  return normalized.length > 0 ? JSON.stringify(normalized) : "";
}

// 完整序列化（含运行时状态），供计费侧回写。
export function serializePeriodCycleState(cycles: PeriodCycle[]): string {
  return cycles.length > 0 ? JSON.stringify(cycles) : "";
}

// 提交体 → 周期档定义。
//
// 返回 cycles 为 undefined 表示「本次不修改周期档」（继承当前值），null/[] 表示「清空」。
// 区分 undefined 与 [] 是为了让「两个额度都留空」能表达「继承上游」：
// 后端把整个字段当作未提交即可，不必造特殊档位。
export function validatePeriodCycles(
  input: unknown,
): { valid: true; cycles: PeriodCycleInput[] | undefined } | { valid: false; error: string } {
  if (input === null) return { valid: true, cycles: [] };
  if (input === undefined) return { valid: true, cycles: undefined };
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return { valid: true, cycles: [] };
    try {
      return validatePeriodCycles(JSON.parse(trimmed));
    } catch {
      return { valid: false, error: "重置周期不是合法的 JSON。" };
    }
  }
  if (!Array.isArray(input)) return { valid: false, error: "重置周期必须为数组。" };
  if (input.length > MAX_PERIOD_CYCLES) return { valid: false, error: `重置周期最多 ${MAX_PERIOD_CYCLES} 档。` };

  const cycles: PeriodCycleInput[] = [];
  const seenSeconds = new Set<number>();
  for (let i = 0; i < input.length; i += 1) {
    const item = input[i];
    if (!item || typeof item !== "object") return { valid: false, error: `第 ${i + 1} 档重置周期格式不正确。` };
    const record = item as Record<string, unknown>;
    if (!isValidPeriodSeconds(record.seconds)) {
      return { valid: false, error: `第 ${i + 1} 档重置周期需为 ${MIN_PERIOD_SECONDS} 到 ${MAX_PERIOD_SECONDS} 之间的整数秒。` };
    }
    // 额度只接受数字或 null：字符串 "-1"、小数 -1.4 一律拒绝，
    // 否则会被 cleanQuota 静默归一成「继承」，把「不限制」悄悄变成「跟着组走」。
    if (!isQuotaInput(record.quota_tokens) || !isQuotaInput(record.quota_requests)) {
      return { valid: false, error: `第 ${i + 1} 档周期的额度需为整数、-1 或留空（null）。` };
    }
    const tokens = record.quota_tokens === undefined ? null : cleanQuota(record.quota_tokens);
    const requests = record.quota_requests === undefined ? null : cleanQuota(record.quota_requests);
    // 两项都为 null 的档位是合法的：表示该周期继承上游（无上游即不限制）。
    // 用户档因此能表达「不动组档」，-1 则表达「覆盖组档为不限制」。
    // 同秒数重复档位没有意义，且会让「哪一档生效」变得不确定
    if (seenSeconds.has(record.seconds)) {
      return { valid: false, error: `第 ${i + 1} 档重置周期与前面的档位重复。` };
    }
    seenSeconds.add(record.seconds);
    cycles.push({
      id: typeof record.id === "string" ? record.id : undefined,
      seconds: record.seconds,
      quota_tokens: tokens,
      quota_requests: requests,
    });
  }
  return { valid: true, cycles };
}

// 旧标量列（单档周期）→ 档位数组。仅供启动时的一次性迁移使用：
// 迁移后判定、计费、展示一律只读 period_cycles。
// 三张表的旧列结构一致：quota_period + period_quota_* + period_used_* + period_reset_at。
export function legacyToPeriodCycle(row: {
  quota_period: number | null;
  period_quota_tokens: number | null;
  period_quota_requests: number | null;
  period_used_tokens: number;
  period_used_requests: number;
  period_reset_at: string | null;
}): PeriodCycle[] {
  if (!isValidPeriodSeconds(row.quota_period)) return [];
  if (row.period_quota_tokens === null && row.period_quota_requests === null) return [];
  const parsedReset = row.period_reset_at ? parseStoredUtc(row.period_reset_at) : null;
  return [{
    id: "legacy",
    seconds: row.quota_period as number,
    quota_tokens: cleanQuota(row.period_quota_tokens),
    quota_requests: cleanQuota(row.period_quota_requests),
    used_tokens: cleanCount(row.period_used_tokens),
    used_requests: cleanCount(row.period_used_requests),
    reset_at: parsedReset ? toMysqlDatetime(parsedReset) : null,
  }];
}

// 周期配额的懒重置需要访问数据库，已拆到 period-cycles-reset.ts，
// 让本模块保持无副作用，可供前端组件直接复用解析与校验逻辑。

// 用户与组都没配置某周期时补出来的占位档：额度为 null，表示「继承但上游没有配置」，
// 也就是这一周期不限制。补出来只是为了让管理员能在界面上给这条周期显式写 -1。
//
// id 必须稳定且非空：它要作为响应头 `X-Period-Quota-*-Remaining-{id}` 的后缀，
// 以及前端列表的 key。空串会让多条占位档互相覆盖、React 报重复 key。
export function placeholderCycle(seconds: number): PeriodCycle {
  return {
    id: `unconfigured-${seconds}`,
    seconds,
    quota_tokens: null,
    quota_requests: null,
    used_tokens: 0,
    used_requests: 0,
    reset_at: null,
  };
}

// 额度是否落在「继承上游」这一态。只有 null 是继承，-1 与 >= 0 都是显式设定。
export function isInheritedQuota(tokens: number | null, requests: number | null): boolean {
  return tokens === null && requests === null;
}

// 「周期档不继承用户组」总开关的落库值。缺省（老数据 / 新建用户 / 列还没写）为 true，
// 只有显式存成 0/false 才关闭。开关只由管理员显式控制，不由档位推断。
export function parseInheritGroupPeriods(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim() === "" ? true : Number(value) !== 0;
  return Number(value) !== 0;
}

// 关闭总开关时用户自有档的落库形态：原本继承组档的那一侧固化成 -1。
// 这是逐档覆盖的写法，不是把组档额度抄进用户档 —— 组档仍只提供定义，
// 重新打开继承或改成数值都能立刻恢复。
//
// 固化会让原本「两侧留空」的档位退出 passThrough、进入计费键空间（见 billableOwn），
// 而这类档位读进来时可能已经过了窗口锚点。若原样回写，下一次计费会把 used_* 归零、
// 重新锚定窗口，等于管理员点一下「关闭继承」就顺手清掉了已过量。
// 因此固化前先按 now 推进一次窗口，让「关闭」本身不改变任何用量事实。
export function detachGroupCycles(cycles: PeriodCycle[], now: Date = new Date()): PeriodCycle[] {
  return cycles.map((cycle) => {
    const resetDate = cycle.reset_at ? parseStoredUtc(cycle.reset_at) : null;
    const expired = !resetDate || resetDate <= now;
    return {
      ...cycle,
      quota_tokens: cycle.quota_tokens ?? -1,
      quota_requests: cycle.quota_requests ?? -1,
      ...(expired
        ? { used_tokens: 0, used_requests: 0, reset_at: toMysqlDatetime(new Date(now.getTime() + cycle.seconds * 1000)) }
        : {}),
    };
  });
}

// 覆盖式写入档位（含运行时状态）。供计费侧在同一事务内累加后回写。
export function applyCycleUsage(
  cycles: PeriodCycle[],
  deltaTokens: number,
  deltaRequests: number,
): PeriodCycle[] {
  if (cycles.length === 0) return cycles;
  return cycles.map((cycle) => ({
    ...cycle,
    used_tokens: cycle.used_tokens + deltaTokens,
    used_requests: cycle.used_requests + deltaRequests,
  }));
}

// 用户周期档的落库形态（新建与编辑共用，保证同一个输入只有一种落库形态）。
//
// inheritGroup=false（关掉「继承用户组周期配额」总开关）时没有上游可继承：
// 提交的留空侧固化成 -1，读取时 resolveEnforcedCycles 同样算作不限制。
//
// 用户档只存「用户自己的意图」，绝不抄组档额度：
// - 某一侧留空 = 这一侧跟着组档走。读取时由 resolveEnforcedCycles 按秒数让位给组档，
//   写库时原样保留 null，组后续放宽/收紧/删除因此始终生效；
// - -1 = 显式不限制，>= 0 = 具体额度，二者都覆盖组档。
//
// 只有一种情况要把留空落成 -1：组里没有该周期的档位。那时留空既没有上游可继承，
// 界面上又说不清含义，落成 -1 才是一条明确的「不限制」。
//
// 运行时计数按秒数从库里保留，否则管理员改额度会把已用量清零、窗口重新锚定。
//
// 交回组档的秒数：提交为两侧留空、且库里这一档原本是显式额度（-1 或数值）。
// 这些秒数在原语义下攒的用量既可能在 period_cycles（显式额度期间）、也可能在
// group_period_cycles（更早的继承期间），两处都得清 —— 只清一处时，另一处的历史用量
// 会在交回后立刻生效，判定与展示还会各读一列、各说一套。
export function resolveHandedBackSeconds(submitted: PeriodCycleInput[], existing: PeriodCycle[]): number[] {
  const existingBySeconds = new Map(existing.map((cycle) => [cycle.seconds, cycle]));
  return submitted.flatMap((cycle) => {
    const prior = existingBySeconds.get(cycle.seconds);
    const backToInherit = isInheritedQuota(cycle.quota_tokens, cycle.quota_requests)
      && prior !== undefined
      && !isInheritedQuota(prior.quota_tokens, prior.quota_requests);
    return backToInherit ? [cycle.seconds] : [];
  });
}

// 提交档位是「重新声明这一档的意图」：只要写进库的形状是 -1 或数值，
// 就必须收口成和 detachGroupCycles 一致的结果，否则「关闭继承时被固化成 -1 的档」
// 会被一次「打开抽屉原样保存」悄悄改回 null，显式不限制的意图随之丢失。
export function resolveUserPeriodCycles(
  submitted: PeriodCycleInput[],
  existing: PeriodCycle[],
  groupCycles: PeriodCycle[],
  inheritGroup = true,
  now: Date = new Date(),
): PeriodCycle[] {
  const groupSeconds = new Set(groupCycles.map((cycle) => cycle.seconds));
  const existingBySeconds = new Map(existing.map((cycle) => [cycle.seconds, cycle]));
  const resolved = submitted.map((cycle, index) => {
    const prior = existingBySeconds.get(cycle.seconds);
    // 留空落成 -1 只在「开着继承、组里却没有这一档」时发生：留空既没有上游可继承、
    // 又说不清含义，落成不限制才是明确的。关掉总开关时另有收口，见函数末尾。
    const needsExplicitUnlimited = inheritGroup && !groupSeconds.has(cycle.seconds);
    // 从「显式额度」（-1 或数值）切回「两侧都留空」时，这一档的计数不属于它了：
    // 遗留的 used_* 是在自有档语义下攒的分，接上组档额度会让用户凭空被自己的历史用量
    // 压住（-1 档已用 150 次、组档给 100，切过去立刻超额）。因此切回继承时计数归零，
    // 由 group_period_cycles 从 0 起算，语义上等于「这一档重新交回组档」。
    // 额度仍原样保留 null（= 跟着组档走），与「提交留空」的落库形态保持一致。
    const backToInherit = needsExplicitUnlimited === false
      && isInheritedQuota(cycle.quota_tokens, cycle.quota_requests)
      && prior !== undefined
      && !isInheritedQuota(prior.quota_tokens, prior.quota_requests);
    if (backToInherit) {
      return {
        ...toCycleFromInput({ ...cycle, quota_tokens: null, quota_requests: null }, prior?.id, `p${index + 1}`),
        used_tokens: 0,
        used_requests: 0,
        reset_at: null,
      };
    }
    return {
      ...toCycleFromInput({
        ...cycle,
        quota_tokens: cycle.quota_tokens ?? (needsExplicitUnlimited ? -1 : null),
        quota_requests: cycle.quota_requests ?? (needsExplicitUnlimited ? -1 : null),
      }, prior?.id, `p${index + 1}`),
      used_tokens: prior?.used_tokens ?? 0,
      used_requests: prior?.used_requests ?? 0,
      reset_at: prior?.reset_at ?? null,
    };
  });
  if (inheritGroup) return resolved;
  // 关掉继承时组档整体不参与：没有任何上游可继承，留空侧一律固化成 -1，
  // 与「关闭开关」这条路径的落库形态保持一致，重新打开后也不会凭空复活继承。
  return detachGroupCycles(resolved, now);
}

// 管理员提交的定义值合并到库里已有的运行时状态上，按秒数对齐。
// 列是「定义 + 运行时」双用途，直接写 serializePeriodCycles 会把 used_*/reset_at 一并清空，
// 等于把用户已消耗的额度归零、并把窗口重新锚定，凭空发放一份完整额度。
// 同秒数的旧档保留已用量与锚点；新增档位从 0 起算。被移除档位的运行时状态随之丢弃。
export function mergeDefinitionOntoState(
  existingRaw: string | null | undefined,
  definitions: PeriodCycleInput[],
): PeriodCycle[] {
  const existing = parsePeriodCycles(existingRaw);
  const bySeconds = new Map(existing.map((cycle) => [cycle.seconds, cycle]));
  return definitions.map((cycle) => {
    const prior = bySeconds.get(cycle.seconds);
    return {
      // 运行时状态一律按 seconds 对齐；id 仅用于展示，因此优先复用同秒数旧档的 id，
      // 避免管理员调换顺序时前端行键无谓抖动。
      id: cycle.id ?? prior?.id ?? "",
      seconds: cycle.seconds,
      quota_tokens: cycle.quota_tokens,
      quota_requests: cycle.quota_requests,
      // 同秒数的旧档保留已用量与锚点；新增档位从 0 起算。
      used_tokens: prior?.used_tokens ?? 0,
      used_requests: prior?.used_requests ?? 0,
      reset_at: prior?.reset_at ?? null,
    };
  });
}

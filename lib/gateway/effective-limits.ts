import { gatewayDb, type DbGroup, type DbUser } from "@/lib/core/db";
import { modelGateFeatures } from "@/lib/core/features";
import { isInheritedQuota, parseInheritGroupPeriods, parsePeriodCycles, placeholderCycle, type PeriodCycle } from "@/lib/gateway/period-cycles";

export type EffectiveLimits = {
  qps: number;
  rpm: number;
  tpm: number;
  quota_requests: number | null;
  quota_tokens: number | null;
  // 生效的周期档（自有 + 继承自组）。继承档的计数存在 users.group_period_cycles，
  // 与自有档分开，保证组配置调整始终对用户生效。
  period_cycles: EnforcedCycles;
  // 用户所属组的原始周期档定义，供调用方按自有档重新计算继承部分。
  group_cycles: PeriodCycle[];
};

function pickRate(userVal: number, groupVal: number): number {
  if (userVal >= 0) return userVal;
  if (groupVal >= 0) return groupVal;
  return -1;
}

function pickQuota(userVal: number | null, groupVal: number | null): number | null {
  if (userVal === -1) return null;
  if (userVal !== null) return userVal;
  // 组表当前不会存 -1，此分支为前瞻性防御
  if (groupVal === -1) return null;
  if (groupVal !== null) return groupVal;
  return null;
}

export async function getUserGroup(groupId: number | null): Promise<DbGroup | null> {
  if (groupId === null) return null;
  const group = await gatewayDb.queryOne<DbGroup>("SELECT * FROM `groups` WHERE id = ? AND enabled = 1 AND deleted_at IS NULL", [groupId]);
  return group ?? null;
}

// 组档只提供定义值：组表没有运行时计数器，计数按用户记在 users.group_period_cycles 上，
// 因此这里把组档的 used 清零，由调用方按秒数接上该用户自己的计数。
function definitionOnly(cycles: PeriodCycle[]): PeriodCycle[] {
  return cycles.map((cycle) => ({ ...cycle, used_tokens: 0, used_requests: 0, reset_at: null }));
}

// 判定与计费共用的生效档位：用户自有档 + 继承自用户组的档位。
// 关键约束：继承档的计数必须与用户自有档**分开存放**（users.group_period_cycles），
// 绝不能写进 users.period_cycles。一旦落进用户行，组档就变成用户自有档，
// 组后续收紧/放宽/删除对该用户永久失效，甚至已删除的组限制会继续拦人。
// 因此这里返回的是「定义视图」，计数由调用方按各自的键空间读写。
export type EnforcedCycles = {
  // 用户自有档：**只含用户自己写的额度**，不含从组档让位来的值。
  // 计数存 users.period_cycles，回写库时必须用这里的形状，否则组档额度会被物化。
  own: PeriodCycle[];
  // 继承自用户组的档位，定义来自组、计数按用户+秒数独立存储（users.group_period_cycles）
  inherited: PeriodCycle[];
  // 生效档位 = 自有档按秒数让位给组档后的结果 + 继承档 + 占位档。
  // 只用于判定与展示，绝不回写库里。
  all: PeriodCycle[];
  // 用户档里两侧都留空、组里也没有可继承额度的秒数：不限制、不计数，只占位。
  passThrough: number[];
};

// 周期档的生效规则：
//
// 1. 自有档按秒数让位给组档：某一侧留空就用组档同周期该侧的额度，-1 或数值则覆盖。
//    让位结果只出现在 all 里，用户档本身（own）保持原样 —— 一旦把组档额度写进
//    users.period_cycles，组后续放宽/收紧/删除对该周期永久失效，
//    正是 group_period_cycles 这套双键空间要避免的「静默物化」。
// 2. 组档里用户没写过自有档的周期，作为继承档直接生效（计数在 group_period_cycles）。
// 3. 两边都没有的常见周期补一条额度为 null 的占位档，只用于展示「这一周期还没配」。
//
// 两侧都留空、组里也没有可继承额度的档位记为 passThrough：不构成限制、不产生计数，
// 既不进判定也不进 group_period_cycles（否则界面上的「不限制」档会偷偷涨用量）。
//
// inheritGroup=false（用户在界面上关掉了「继承用户组周期配额」总开关）时组档整体不参与：
// 没有可让位的上游，留空那一侧直接算不限制，passThrough 也随之为空。
// 开关只影响「组档能不能挡到这个人」，用户自己写的额度（含 -1）一律照旧。
export function resolveEnforcedCycles(
  userCycles: PeriodCycle[],
  groupCycles: PeriodCycle[],
  inheritGroup = true,
): EnforcedCycles {
  const effectiveGroupCycles = inheritGroup ? groupCycles : [];
  const groupBySeconds = new Map(effectiveGroupCycles.map((cycle) => [cycle.seconds, cycle]));

  const own = userCycles.slice();

  // 哪些秒数该按「继承档」计数：用户档两侧都留空的周期。
  // 有同周期组档时它要让位、计数跟着组档走（否则用户行和 group_period_cycles 各记一份）；
  // 组里也没有时它就是个空占位，同样不该在 own 里计费。
  const inheritCountSeconds = new Set(
    userCycles
      .filter((cycle) => isInheritedQuota(cycle.quota_tokens, cycle.quota_requests))
      .map((cycle) => cycle.seconds),
  );
  const passThrough = [...inheritCountSeconds].filter((seconds) => !groupBySeconds.has(seconds));

  // 组档里用户没写过显式额度的周期作为继承档生效：既包括用户没提过的周期，
  // 也包括用户写了但两侧留空的周期（那种情况下额度全来自组档，计数也必须记在
  // group_period_cycles 上）。因此这两类都进 inherited。
  const ownSeconds = new Set(own.map((cycle) => cycle.seconds));
  const inherited = effectiveGroupCycles
    .filter((cycle) => !ownSeconds.has(cycle.seconds) || inheritCountSeconds.has(cycle.seconds))
    .map((cycle) => definitionOnly([cycle])[0]);

  // 自有档在 all 里的形态：某一侧留空就沿用组档该侧的额度，-1 与数值则覆盖组档。
  // 逐侧判断而不是看整个档位，否则「只填 Token」会把组的请求上限一起抹掉。
  // 运行时计数一并清零：all 是定义视图（生效额度），计数由调用方按各自键空间填。
  // 带着自有档的 used_* 会让「直接拿 all 展示」的调用方看到过去的用量。
  const enforcedOwn = own.map((cycle) => {
    const fromGroup = groupBySeconds.get(cycle.seconds);
    return {
      ...cycle,
      quota_tokens: cycle.quota_tokens ?? fromGroup?.quota_tokens ?? -1,
      quota_requests: cycle.quota_requests ?? fromGroup?.quota_requests ?? -1,
      used_tokens: 0,
      used_requests: 0,
      reset_at: null,
    };
  });

  // 同秒数在 all 里只能有一条：额度可能一侧来自自有档、另一侧来自组档，而计数分存两列
  // （自有档记 users.period_cycles，继承档记 users.group_period_cycles）。两条并存时判定
  // 只命中先出现的那条，另一列的用量永远读不到 —— 组档限额于是形同虚设。
  // 因此统一由自有档那条承载（enforcedOwn 已逐侧让位），继承档那条只补自有档没有的秒数。
  const enforcedSeconds = new Set(enforcedOwn.map((cycle) => cycle.seconds));
  const all = [...enforcedOwn, ...inherited.filter((cycle) => !enforcedSeconds.has(cycle.seconds))];
  const coveredSeconds = new Set(all.map((cycle) => cycle.seconds));
  const resolvedAll = [...all, ...unconfiguredSeconds(coveredSeconds).map(placeholderCycle)]
    .sort((a, b) => a.seconds - b.seconds);

  return { own, inherited, all: resolvedAll, passThrough };
}

// 常见周期里，用户与组都没配置、但需要让管理员能显式写 -1 的那几档。
// 只补常见档位（小时/天/周/月），自定义秒数仍以两边已有配置为准。
const COMMON_PERIOD_SECONDS = [3600, 86400, 604800, 2592000];

function unconfiguredSeconds(covered: Set<number>): number[] {
  return COMMON_PERIOD_SECONDS.filter((seconds) => !covered.has(seconds));
}

export const mergePeriodCycles = resolveEnforcedCycles;

export type EffectiveLimitsInput = Pick<
  DbUser,
  "group_id" | "qps" | "rpm" | "tpm" | "quota_requests" | "quota_tokens" | "period_cycles"
> & {
  // 周期配额总开关：0 = 不继承用户组周期档。缺省/null 按继承处理（老数据与新建用户）。
  inherit_group_periods?: number | null;
};

export async function getEffectiveLimits(user: EffectiveLimitsInput): Promise<EffectiveLimits> {
  const group = await getUserGroup(user.group_id);

  // 周期档只认 period_cycles：旧单档列已停止写入，启动迁移已把存量单档配置折成档位，
  // 因此判定、计费、展示三处共用这一个口径。
  const userCycles = parsePeriodCycles(user.period_cycles);
  const inheritGroup = parseInheritGroupPeriods(user.inherit_group_periods);
  const groupCycles = parsePeriodCycles(group?.period_cycles);
  const merged = modelGateFeatures.periodQuota
    ? mergePeriodCycles(userCycles, groupCycles, inheritGroup)
    : { own: [], inherited: [], all: [], passThrough: [] };

  return {
    qps: pickRate(user.qps, group?.qps ?? -1),
    rpm: pickRate(user.rpm, group?.rpm ?? -1),
    tpm: pickRate(user.tpm, group?.tpm ?? -1),
    quota_requests: pickQuota(user.quota_requests, group?.quota_requests ?? null),
    quota_tokens: pickQuota(user.quota_tokens, group?.quota_tokens ?? null),
    period_cycles: merged,
    // 关掉继承时组档对判定与计费完全不可见，因此这里一并透出空数组：
    // 调用方都直接拿它做「继承部分」的计算，留原值会让关掉的开关在残留路径上复活。
    group_cycles: modelGateFeatures.periodQuota && inheritGroup ? groupCycles : [],
  };
}

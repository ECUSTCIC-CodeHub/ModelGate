import { gatewayDb, type DbGroup, type DbUser } from "@/lib/core/db";
import { modelGateFeatures } from "@/lib/core/features";
import { inheritedCycleTemplate, parsePeriodCycles, type PeriodCycle } from "@/lib/gateway/period-cycles";

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
// 因此这里只做「定义合并」，计数由调用方按各自的键空间读写。
export type EnforcedCycles = {
  // 用户自有档（计数存 users.period_cycles）
  own: PeriodCycle[];
  // 继承自用户组的档位，定义来自组、计数按用户+秒数独立存储
  inherited: PeriodCycle[];
  // own + inherited，供逐档判定使用
  all: PeriodCycle[];
};

// 周期档的生效规则（与整体配额同构，留空都是「继承上游」）：
//
// 1. 自有档按秒数在组档基础上合并：用户档某一侧额度留空时沿用组档该周期的额度，
//    写 -1 或具体数值则覆盖组档。因此「某一档只填 Token、请求留空」不再静默作废
//    组档的请求上限。两侧都没配时留空落成 -1，不放行空额度档位。
// 2. 组档里用户没写过自有档的周期，作为继承档直接生效。
// 3. 两边都没有的常见周期补一条额度为 null 的档位（继承但无上游 = 不限制），
//    用户可以在那条上填 -1，使「这一周期不限制」成为显式配置。
//
// 自有档的运行时计数记在 users.period_cycles，继承档记在 users.group_period_cycles，
// 两条键空间不能混。
export function resolveEnforcedCycles(userCycles: PeriodCycle[], groupCycles: PeriodCycle[]): EnforcedCycles {
  const groupBySeconds = new Map(groupCycles.map((cycle) => [cycle.seconds, cycle]));
  const own: PeriodCycle[] = [];

  // 自有档与组档按同一周期合并：自有额度为 null 的那一侧沿用组档，-1 或数值则覆盖组档。
  // 两侧都没配该周期时，自有额度为 null 属「继承但无上游」，直接落成 -1，
  // 与「留空即继承、-1 即不限制」的契约一致，不留下永远不生效的空额度档位。
  for (const cycle of userCycles) {
    const fromGroup = groupBySeconds.get(cycle.seconds);
    own.push({
      ...cycle,
      quota_tokens: fromGroup && cycle.quota_tokens === null ? fromGroup.quota_tokens : (cycle.quota_tokens ?? -1),
      quota_requests: fromGroup && cycle.quota_requests === null ? fromGroup.quota_requests : (cycle.quota_requests ?? -1),
    });
  }

  const ownSeconds = new Set(own.map((cycle) => cycle.seconds));
  const inherited = groupCycles
    .filter((cycle) => !ownSeconds.has(cycle.seconds))
    .map((cycle) => definitionOnly([cycle])[0]);

  const all = [
    ...own,
    ...inherited,
    ...unconfiguredSeconds(own, inherited).map(inheritedCycleTemplate),
  ].sort((a, b) => a.seconds - b.seconds);

  return { own, inherited, all };
}

// 常见周期里，用户与组都没配置、但需要让用户能显式写 -1 的那几档。
// 只补常见档位（小时/天/周/月），自定义秒数仍以两边已有配置为准。
const COMMON_PERIOD_SECONDS = [3600, 86400, 604800, 2592000];

function unconfiguredSeconds(own: PeriodCycle[], inherited: PeriodCycle[]): number[] {
  const covered = new Set([...own, ...inherited].map((cycle) => cycle.seconds));
  return COMMON_PERIOD_SECONDS.filter((seconds) => !covered.has(seconds));
}

export const mergePeriodCycles = resolveEnforcedCycles;

export type EffectiveLimitsInput = Pick<
  DbUser,
  "group_id" | "qps" | "rpm" | "tpm" | "quota_requests" | "quota_tokens" | "period_cycles"
>;

export async function getEffectiveLimits(user: EffectiveLimitsInput): Promise<EffectiveLimits> {
  const group = await getUserGroup(user.group_id);

  // 周期档只认 period_cycles：旧单档列已停止写入，启动迁移已把存量单档配置折成档位，
  // 因此判定、计费、展示三处共用这一个口径。
  const userCycles = parsePeriodCycles(user.period_cycles);
  const groupCycles = parsePeriodCycles(group?.period_cycles);
  const merged = modelGateFeatures.periodQuota ? mergePeriodCycles(userCycles, groupCycles) : { own: [], inherited: [], all: [] };

  return {
    qps: pickRate(user.qps, group?.qps ?? -1),
    rpm: pickRate(user.rpm, group?.rpm ?? -1),
    tpm: pickRate(user.tpm, group?.tpm ?? -1),
    quota_requests: pickQuota(user.quota_requests, group?.quota_requests ?? null),
    quota_tokens: pickQuota(user.quota_tokens, group?.quota_tokens ?? null),
    period_cycles: merged,
    group_cycles: modelGateFeatures.periodQuota ? groupCycles : [],
  };
}

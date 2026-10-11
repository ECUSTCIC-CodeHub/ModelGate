import { gatewayDb, type DbGroup, type DbUser } from "@/lib/core/db";
import { modelGateFeatures } from "@/lib/core/features";
import { parsePeriodCycles, type PeriodCycle } from "@/lib/gateway/period-cycles";

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

export function resolveEnforcedCycles(userCycles: PeriodCycle[], groupCycles: PeriodCycle[]): EnforcedCycles {
  if (groupCycles.length === 0) return { own: userCycles, inherited: [], all: userCycles };
  const ownSeconds = new Set(userCycles.map((cycle) => cycle.seconds));
  const inherited = groupCycles
    .filter((cycle) => !ownSeconds.has(cycle.seconds))
    .map((cycle) => definitionOnly([cycle])[0]);
  return { own: userCycles, inherited, all: [...userCycles, ...inherited] };
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

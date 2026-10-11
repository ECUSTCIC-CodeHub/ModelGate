import { gatewayDb, type DbGroup, type DbUser } from "@/lib/core/db";
import { modelGateFeatures } from "@/lib/core/features";
import { parsePeriodCycles, type PeriodCycle } from "@/lib/gateway/period-cycles";

export type EffectiveLimits = {
  qps: number;
  rpm: number;
  tpm: number;
  quota_requests: number | null;
  quota_tokens: number | null;
  quota_period: number | null;
  period_quota_tokens: number | null;
  period_quota_requests: number | null;
  // 生效的周期档：用户按秒数覆盖组的同名档，其余组档继承。
  period_cycles: PeriodCycle[];
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

function pickPeriod(userVal: number | null, groupVal: number | null): number | null {
  if (userVal !== null && userVal > 0) return userVal;
  if (groupVal !== null && groupVal > 0) return groupVal;
  return null;
}

export async function getUserGroup(groupId: number | null): Promise<DbGroup | null> {
  if (groupId === null) return null;
  const group = await gatewayDb.queryOne<DbGroup>("SELECT * FROM `groups` WHERE id = ? AND enabled = 1 AND deleted_at IS NULL", [groupId]);
  return group ?? null;
}

// 组档只提供定义值，运行时计数始终记在用户行上，因此这里把组档的 used 清零。
function definitionOnly(cycles: PeriodCycle[]): PeriodCycle[] {
  return cycles.map((cycle) => ({ ...cycle, used_tokens: 0, used_requests: 0, reset_at: null }));
}

// 按秒数合并用户档与组档：用户显式配置的档覆盖组同名档，组中未被覆盖的档继承。
// 继承来的档位不带运行时计数（组表没有计数器），只作为定义值参与判定；
// 用户行上同名档的计数由 quota.ts 单独叠加，避免把组配置快照进用户行。
export function mergePeriodCycles(userCycles: PeriodCycle[], groupCycles: PeriodCycle[]): PeriodCycle[] {
  if (userCycles.length === 0) return definitionOnly(groupCycles);
  if (groupCycles.length === 0) return userCycles;
  const ownSeconds = new Set(userCycles.map((cycle) => cycle.seconds));
  const inherited = definitionOnly(groupCycles).filter((cycle) => !ownSeconds.has(cycle.seconds));
  return [...userCycles, ...inherited];
}

export async function getEffectiveLimits(user: DbUser): Promise<EffectiveLimits> {
  const group = await getUserGroup(user.group_id);

  const userCycles = parsePeriodCycles(user.period_cycles);
  const groupCycles = parsePeriodCycles(group?.period_cycles);
  const merged = modelGateFeatures.periodQuota ? mergePeriodCycles(userCycles, groupCycles) : [];

  // 旧单档列继续生效：周期与额度都按「用户值优先、否则组值」取值，
  // 与改造前的 pickPeriod / pickQuota 行为一致。
  const legacyPeriod = modelGateFeatures.periodQuota
    ? pickPeriod(user.quota_period ?? null, group?.quota_period ?? null)
    : null;

  return {
    qps: pickRate(user.qps, group?.qps ?? -1),
    rpm: pickRate(user.rpm, group?.rpm ?? -1),
    tpm: pickRate(user.tpm, group?.tpm ?? -1),
    quota_requests: pickQuota(user.quota_requests, group?.quota_requests ?? null),
    quota_tokens: pickQuota(user.quota_tokens, group?.quota_tokens ?? null),
    quota_period: legacyPeriod,
    period_quota_tokens: legacyPeriod ? pickQuota(user.period_quota_tokens ?? null, group?.period_quota_tokens ?? null) : null,
    period_quota_requests: legacyPeriod ? pickQuota(user.period_quota_requests ?? null, group?.period_quota_requests ?? null) : null,
    period_cycles: merged,
  };
}

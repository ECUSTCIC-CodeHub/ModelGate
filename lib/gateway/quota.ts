import { gatewayDb } from "@/lib/core/db";
import { getEffectiveLimits } from "@/lib/gateway/effective-limits";
import { parsePeriodCycles, type PeriodCycle } from "@/lib/gateway/period-cycles";
import { ensureCycleResets, loadGroupCycleState } from "@/lib/gateway/period-cycles-reset";
import { formatPeriodLabel } from "@/lib/shared/period-format";

export type PeriodQuotaEntry = {
  id: string;
  period_seconds: number;
  period_label: string;
  quota_tokens: number | null;
  quota_requests: number | null;
  used_tokens: number;
  used_requests: number;
  remaining_tokens: number | null;
  remaining_requests: number | null;
  reset_at: string | null;
};

export type QuotaInfo = {
  remaining_requests: number | null;
  remaining_tokens: number | null;
  periods: PeriodQuotaEntry[];
};

// 旧的单档响应头保留，取「最先触发」的档位，避免老客户端读到空值。
function firstConfigured(periods: PeriodQuotaEntry[]): PeriodQuotaEntry | null {
  return periods.length > 0 ? periods[0] : null;
}

export function appendQuotaHeaders(headers: Record<string, string>, quota: QuotaInfo) {
  if (quota.remaining_requests !== null) {
    headers["X-Quota-Limit-Requests-Remaining"] = String(quota.remaining_requests);
  }
  if (quota.remaining_tokens !== null) {
    headers["X-Quota-Limit-Tokens-Remaining"] = String(quota.remaining_tokens);
  }
  const head = firstConfigured(quota.periods);
  if (head) {
    if (head.remaining_requests !== null) {
      headers["X-Period-Quota-Requests-Remaining"] = String(head.remaining_requests);
    }
    if (head.remaining_tokens !== null) {
      headers["X-Period-Quota-Tokens-Remaining"] = String(head.remaining_tokens);
    }
    if (head.reset_at) {
      headers["X-Period-Quota-Reset"] = head.reset_at;
    }
  }
  for (const period of quota.periods) {
    // 后缀就是档位 id，空串会写出 `...-Remaining-` 这种无名头，多档之间互相覆盖。
    // 正常路径上 id 一定非空（占位档也带 unconfigured-<seconds>），这里只是兜底。
    if (!period.id) continue;
    if (period.remaining_requests !== null) {
      headers[`X-Period-Quota-Requests-Remaining-${period.id}`] = String(period.remaining_requests);
    }
    if (period.remaining_tokens !== null) {
      headers[`X-Period-Quota-Tokens-Remaining-${period.id}`] = String(period.remaining_tokens);
    }
    if (period.reset_at) {
      headers[`X-Period-Quota-Reset-${period.id}`] = period.reset_at;
    }
  }
}

// 生效档位的额度与计数来自两处：额度是让位后的值，计数分存 period_cycles / group_period_cycles。
// 同一个秒数下，自有档与继承档两边的计数都可能非零（一侧额度由用户写、另一侧沿用组档），
// 因此逐侧取两边的较大值 —— 只认其中一边会让另一边的用量消失，那一侧的限额就失效了。
function mergeCycleState(
  cycle: PeriodCycle,
  own: PeriodCycle | undefined,
  inherited: PeriodCycle | undefined,
): PeriodCycle {
  if (!own && !inherited) return cycle;
  const usedTokens = Math.max(own?.used_tokens ?? 0, inherited?.used_tokens ?? 0);
  const usedRequests = Math.max(own?.used_requests ?? 0, inherited?.used_requests ?? 0);
  const resetAt = own?.reset_at ?? inherited?.reset_at ?? null;
  return { ...cycle, used_tokens: usedTokens, used_requests: usedRequests, reset_at: resetAt };
}

// 自有档 → 库里真实存在的行：只保留 ownRaw 里出现过的秒数。
// 额度沿用 sql 里的用户形状（不含组档让位值），计数与窗口锚点取库里的
// （不能拿内存里的 0 去覆盖用户已用量）。
export function storedOwnShape(own: PeriodCycle[], ownRaw: string | null): PeriodCycle[] {
  const storedBySeconds = new Map(parsePeriodCycles(ownRaw).map((cycle) => [cycle.seconds, cycle]));
  return own.flatMap((cycle) => {
    const stored = storedBySeconds.get(cycle.seconds);
    if (!stored) return [];
    return [{ ...cycle, id: stored.id, used_tokens: stored.used_tokens, used_requests: stored.used_requests, reset_at: stored.reset_at }];
  });
}

// 生效档位的当前状态：自有档的计数在 users.period_cycles，继承档的计数在
// users.group_period_cycles，两处分开存放，因此必须分别推进窗口再合并。
// 只读 getEffectiveLimits 的 period_cycles 会漏掉继承档的实际用量（组表只有定义值），
// 与判定、计费口径不一致。
//
// enforced 必须来自 resolveEnforcedCycles：own 是用户自己写的形状，inherited 是
// 组档没被覆盖的部分，all 是让位后的生效值（展示与判定都用它）。
export async function resolveEffectivePeriods(
  userId: number,
  enforced: { own: PeriodCycle[]; inherited: PeriodCycle[]; all?: PeriodCycle[] },
  ownRaw: string | null,
): Promise<PeriodQuotaEntry[]> {
  // 自有档只推进**库里原有的**那些档位的窗口：enforced.own 只含用户自己写的额度，
  // 但 id / 计数 / 锚点必须以库里的为准，否则会把未落库的形状写进去。
  const own = enforced.own.length > 0
    ? await ensureCycleResets("users", userId, storedOwnShape(enforced.own, ownRaw), undefined, ownRaw)
    : [];
  const inherited = enforced.inherited.length > 0
    ? await loadGroupCycleState(userId, enforced.inherited, undefined, false)
    : [];
  const ownBySeconds = new Map(own.map((cycle) => [cycle.seconds, cycle]));
  const inheritedBySeconds = new Map(inherited.map((cycle) => [cycle.seconds, cycle]));
  // 额度取生效值（可能是从组档让位来的），计数与锚点取各自键空间的实时值。
  // 两条键空间都要并进来：一个档位可能一侧由自有档限定（计数记 period_cycles）、
  // 另一侧沿用组档（计数记 group_period_cycles），只取其中一侧会让另一侧的用量凭空消失。
  const effective = (enforced.all ?? [...enforced.own, ...enforced.inherited])
    .map((cycle) => mergeCycleState(cycle, ownBySeconds.get(cycle.seconds), inheritedBySeconds.get(cycle.seconds)));
  return effective.map(toPeriodQuotaEntry).sort((a, b) => a.period_seconds - b.period_seconds);
}

// -1 是「显式不限制」的哨兵值：没有可用量，也不是「未配置」。
// 对外响应里额度原样透出 -1（保留来源信息），剩余量则一律为 null。
function remainingQuota(quota: number | null, used: number): number | null {
  if (quota === null || quota < 0) return null;
  return Math.max(0, quota - used);
}

export function toPeriodQuotaEntry(cycle: PeriodCycle): PeriodQuotaEntry {
  return {
    id: cycle.id,
    period_seconds: cycle.seconds,
    period_label: formatPeriodLabel(cycle.seconds),
    quota_tokens: cycle.quota_tokens,
    quota_requests: cycle.quota_requests,
    used_tokens: cycle.used_tokens,
    used_requests: cycle.used_requests,
    remaining_tokens: remainingQuota(cycle.quota_tokens, cycle.used_tokens),
    remaining_requests: remainingQuota(cycle.quota_requests, cycle.used_requests),
    reset_at: cycle.reset_at,
  };
}

// 逐档判定，返回首个被触发的档位（含周期名，便于定位是哪一档限制）。
// Token 档为「本次请求」预留预算（used + estimated > quota），Requests 档则按已用次数判定
// （本次请求尚未计入 used），与全局配额 checkQuota 的口径保持一致。
export function findExceededCycle(cycles: PeriodCycle[], estimatedTokens: number): { reason: string } | null {
  for (const cycle of cycles) {
    const label = formatPeriodLabel(cycle.seconds);
    // null（继承无上游）与 -1（显式不限制）都不构成限制，只有 >= 0 才判定。
    if (cycle.quota_requests !== null && cycle.quota_requests >= 0 && cycle.used_requests >= cycle.quota_requests) {
      return { reason: `周期请求配额已用尽（${label}）` };
    }
    if (cycle.quota_tokens !== null && cycle.quota_tokens >= 0 && cycle.used_tokens + estimatedTokens > cycle.quota_tokens) {
      return { reason: `周期 Token 配额已用尽（${label}）` };
    }
  }
  return null;
}

export async function checkQuota(userId: number, estimatedTokens: number): Promise<{ ok: false; reason: string; quota?: QuotaInfo } | { ok: true; quota: QuotaInfo }> {
  const user = await gatewayDb.queryOne<{
    id: number;
    group_id: number | null;
    quota_tokens: number | null;
    quota_requests: number | null;
    used_tokens: number;
    used_requests: number;
    period_cycles: string | null;
    inherit_group_periods: number | null;
    rpm: number;
    qps: number;
    tpm: number;
  }>(
    `SELECT id, group_id, quota_tokens, quota_requests, used_tokens, used_requests,
              period_cycles, inherit_group_periods,
              rpm, qps, tpm FROM users WHERE id = ? AND deleted_at IS NULL`,
    [userId],
  );

  if (!user) {
    return { ok: false, reason: "用户不存在" };
  }

  const limits = await getEffectiveLimits(user);

  const quota: QuotaInfo = {
    remaining_requests: limits.quota_requests !== null && limits.quota_requests >= 0
      ? Math.max(0, limits.quota_requests - user.used_requests)
      : null,
    remaining_tokens: limits.quota_tokens !== null && limits.quota_tokens >= 0
      ? Math.max(0, limits.quota_tokens - user.used_tokens)
      : null,
    periods: [],
  };

  // pickQuota 已把用户级 -1 归一成 null，这里再挡一次 -1，避免「显式不限制」被当成 0 额度。
  if (limits.quota_requests !== null && limits.quota_requests >= 0 && user.used_requests >= limits.quota_requests) {
    return { ok: false, reason: "请求配额已用尽", quota };
  }

  if (limits.quota_tokens !== null && limits.quota_tokens >= 0 && user.used_tokens + estimatedTokens > limits.quota_tokens) {
    return { ok: false, reason: "Token 配额已用尽", quota };
  }

  // 用户自有的周期档 + 继承自用户组的档位。
  // 两者的计数分开存放：自有档用 users.period_cycles，继承档用 users.group_period_cycles。
  // 分开是为了让组配置的后续调整（收紧/放宽/删除）始终对用户生效。
  // getEffectiveLimits 已按同一口径算好生效档位（自有 + 继承），直接复用，
  // 避免这里再算一遍形成两份真值来源。
  const enforced = limits.period_cycles;

  if (enforced.all.length > 0) {
    const own = enforced.own.length > 0
      ? await ensureCycleResets("users", userId, enforced.own, undefined, user.period_cycles)
      : [];
    const inherited = enforced.inherited.length > 0
      ? await loadGroupCycleState(userId, enforced.inherited)
      : [];
    // 判定用生效档位（自有档让位给组档后的额度），计数取各自键空间的实时值。
    // 同秒数可能同时存在两条键空间的计数（跨侧覆盖），按侧取大值，不能只认自有档那条。
    const ownBySeconds = new Map(own.map((cycle) => [cycle.seconds, cycle]));
    const inheritedBySeconds = new Map(inherited.map((cycle) => [cycle.seconds, cycle]));
    const all = enforced.all.map((cycle) => mergeCycleState(cycle, ownBySeconds.get(cycle.seconds), inheritedBySeconds.get(cycle.seconds)));
    quota.periods = all.map(toPeriodQuotaEntry);
    const exceeded = findExceededCycle(all, estimatedTokens);
    if (exceeded) {
      return { ok: false, reason: exceeded.reason, quota };
    }
  }

  return { ok: true, quota };
}

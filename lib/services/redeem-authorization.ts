import { gatewayDb, type DbGroup, type DbUser } from "@/lib/core/db";
import { toMysqlDatetime } from "@/lib/core/db/datetime";
import { getGatewaySettings } from "@/lib/core/settings";
import { modelGateFeatures } from "@/lib/core/features";
import { getUserGroup } from "@/lib/gateway/effective-limits";
import { parseAllowedChannelIds } from "@/lib/gateway/channel-access";
import { resolveStoredPeriodCycles } from "@/lib/gateway/period-cycles";
import { ensureCycleResets } from "@/lib/gateway/period-cycles-reset";
import { findExceededCycle } from "@/lib/gateway/quota";

// 授权区域：channelIds 空 = 任意渠道。aliases 的空值语义按来源分两种，用 aliasWildcard 显式区分：
//   兑换额度（true）：空 = 任意别名，与计费侧 findMatchingRedeemBalance 的口径一致；
//   用户/组白名单（false）：空 = 不额外授权非公开模型（公开模型由 models.is_public 单独放行）。
// 两者共用一份配对判定，但空值语义不能混为一谈。
export type AccessScope = {
  channelIds: number[];
  aliases: string[];
  aliasWildcard: boolean;
};

function parseAliases(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// 由额度存储字段构造授权区域。兑换额度的空限定表示「不限」，
// 因此空别名即任意别名（与计费侧、API.md 口径一致）。
export function buildRedeemScope(allowedChannelIds: string | null, allowedModelAliases: string | null): AccessScope {
  const aliases = parseAliases(allowedModelAliases);
  return {
    aliases,
    channelIds: parseAllowedChannelIds(allowedChannelIds),
    aliasWildcard: aliases.length === 0,
  };
}

type BalanceQuotaRow = {
  allowed_model_aliases: string | null;
  allowed_channel_ids: string | null;
  token_quota: number | null;
  request_quota: number | null;
  used_tokens: number;
  used_requests: number;
  expires_at: string | null;
  period_cycles: string | null;
};

// 周期档耗尽即视为额度用尽：用户彻底失去该额度带来的渠道/模型访问权，下个周期自动恢复。
export function balanceHasRemaining(row: {
  token_quota: number | null;
  request_quota: number | null;
  used_tokens: number;
  used_requests: number;
  period_cycles: string | null;
}): boolean {
  if (row.token_quota !== null && row.used_tokens >= row.token_quota) return false;
  if (row.request_quota !== null && row.used_requests >= row.request_quota) return false;
  const cycles = resolveStoredPeriodCycles(row.period_cycles, {
    quota_period: null, period_quota_tokens: null, period_quota_requests: null,
    period_used_tokens: 0, period_used_requests: 0, period_reset_at: null,
  });
  return findExceededCycle(cycles, 0) === null;
}

// 兑换额度的周期档懒重置。核销时快照下来的档位只带定义值、reset_at 为 null，
// 若不在这里推进窗口，周期额度就退化成一次性总额度：首周期用尽后永远判定为耗尽。
// 本条额度是「已发放」的行，因此按秒数把重置后的运行时状态写回自身。
export async function ensureBalanceCycleResets(row: BalanceQuotaRow & { id: number }): Promise<void> {
  const cycles = resolveStoredPeriodCycles(row.period_cycles, {
    quota_period: null, period_quota_tokens: null, period_quota_requests: null,
    period_used_tokens: 0, period_used_requests: 0, period_reset_at: null,
  });
  if (cycles.length === 0) return;
  await ensureCycleResets("redeem_balances", row.id, cycles, undefined, row.period_cycles);
}

// 用户有效定向额度（兑换码）的限定区域，按每张额度各自返回，不做跨额度的渠道/别名并集，
// 否则「渠道9+别名A」会被拆成两个单维白名单、放行配对区域外的组合。
// 额度用尽/过期/兑换码停用后自动回收。
export async function listRedeemScopes(userId: number): Promise<AccessScope[]> {
  // 功能关闭时授权来源一并失效，否则「关闭开关」只是藏了入口，已兑换用户仍拿着兑换码换来的渠道/模型权限。
  if (!(await getGatewaySettings()).runtime_features.redeemCode) return [];

  const now = toMysqlDatetime(new Date());
  const rows = await gatewayDb.query<BalanceQuotaRow & { id: number }>(
    `SELECT b.id, b.allowed_model_aliases, b.allowed_channel_ids,
            b.token_quota, b.request_quota, b.used_tokens, b.used_requests,
            b.expires_at, b.period_cycles
       FROM redeem_balances b
       JOIN redeem_codes c ON c.id = b.code_id
       WHERE b.user_id = ?
         AND c.enabled = 1
         AND (b.expires_at IS NULL OR b.expires_at > ?)
         AND (b.token_quota IS NULL OR b.used_tokens < b.token_quota)
         AND (b.request_quota IS NULL OR b.used_requests < b.request_quota)`,
    [userId, now],
  );
  // 先推进已到期的周期窗口，再判定余量，否则上个周期用尽的额度会被永久判定为耗尽。
  for (const row of rows) {
    if (modelGateFeatures.periodQuota) await ensureBalanceCycleResets(row);
  }
  return rows
    .filter(balanceHasRemaining)
    .map((row) => buildRedeemScope(row.allowed_channel_ids, row.allowed_model_aliases));
}

// 单个授权区域的「配对」判定：渠道与别名需落在同一区域内。
// channelIds 空 = 任意渠道；aliases 是否通配由 aliasWildcard 决定（见 AccessScope 注释）。
export function scopeCoversPair(scope: AccessScope, channelId: number | null, modelAlias: string | null): boolean {
  if (channelId === null || !modelAlias) return false;
  const channelMatch = scope.channelIds.length === 0 || scope.channelIds.includes(channelId);
  const aliasMatch = scope.aliasWildcard || scope.aliases.includes(modelAlias);
  return channelMatch && aliasMatch;
}

export function scopesCoverPair(scopes: AccessScope[], channelId: number | null, modelAlias: string | null): boolean {
  return scopes.some((scope) => scopeCoversPair(scope, channelId, modelAlias));
}

// 别名级判定：网关在拿到具体渠道之前无法做配对判定，别名门禁只能用这个宽松口径，
// 真正的配对收紧发生在选路阶段（filterGrantedRows → scopeCoversPair）。
export function scopeHasAlias(scope: AccessScope, modelAlias: string | null): boolean {
  if (!modelAlias) return false;
  return scope.aliasWildcard || scope.aliases.includes(modelAlias);
}

export function scopesHaveAlias(scopes: AccessScope[], modelAlias: string | null): boolean {
  return scopes.some((scope) => scopeHasAlias(scope, modelAlias));
}

// 用户自身（用户 + 用户组）的限定区域。两个维度都为空表示不受限，
// 返回 null 与「有具体限定但都不覆盖该配对」区分开。
// 别名维度取「用户白名单 ∪ 组白名单」，为空即不额外授权非公开模型（aliasWildcard 恒为 false）。
export async function getUserScope(user: Pick<DbUser, "group_id" | "allowed_model_aliases">): Promise<AccessScope | null> {
  const group: DbGroup | null = await getUserGroup(user.group_id ?? null);
  const channelIds = parseAllowedChannelIds(group?.allowed_channel_ids);
  const aliases = [...new Set([
    ...parseAliases(user.allowed_model_aliases),
    ...parseAliases(group?.allowed_model_aliases),
  ])];
  if (channelIds.length === 0 && aliases.length === 0) return null;
  return { channelIds, aliases, aliasWildcard: false };
}

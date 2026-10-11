export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/core/db";
import { ensureUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";
import { parseStoredUtc } from "@/lib/core/db/datetime";
import { parseAllowedModelAliases } from "@/lib/gateway/model-access";
import { parseAllowedChannelIds } from "@/lib/gateway/channel-access";
import { getUserScope, listRedeemScopes, scopeCoversPair, scopesCoverPair } from "@/lib/services/redeem-authorization";
import { resolveStoredPeriodCycles } from "@/lib/gateway/period-cycles";
import { toPeriodQuotaEntry } from "@/lib/gateway/quota";
import { parseMultiplierSchedules, resolveEffectiveMultiplier } from "@/lib/gateway/multiplier-schedule";
import { formatPeriodLabel } from "@/lib/shared/period-format";

export async function GET(request: Request) {
  const guard = await ensureUser(request);
  if ("error" in guard) return guard.error;

  const user = guard.auth.user;
  const group = user.group_id
    ? (await gatewayDb.queryOne<{ allowed_model_aliases: string; allowed_channel_ids: string }>("SELECT allowed_model_aliases, allowed_channel_ids FROM `groups` WHERE id = ? AND enabled = 1 AND deleted_at IS NULL", [user.group_id]))
    : null;

  const userAllowedAliases = parseAllowedModelAliases(user.allowed_model_aliases);
  const groupAllowedAliases = parseAllowedModelAliases(group?.allowed_model_aliases);
  const groupAllowedChannels = parseAllowedChannelIds(group?.allowed_channel_ids);

  const models = await gatewayDb.query<{
    id: number;
    alias: string;
    real_model: string;
    channel_id: number;
    channel_name: string;
    is_public: number;
    quota_mode: string;
    quota_tokens: number | null;
    quota_requests: number | null;
    quota_period: number | null;
    period_quota_tokens: number | null;
    period_quota_requests: number | null;
    period_used_tokens: number;
    period_used_requests: number;
    period_reset_at: string | null;
    period_cycles: string | null;
    multiplier_schedules: string | null;
    token_multiplier: number;
    request_multiplier: number;
  }>(
    `SELECT m.id, m.alias, m.real_model, m.channel_id, c.name AS channel_name, m.is_public, m.quota_mode,
            m.quota_tokens, m.quota_requests, m.quota_period,
            m.period_quota_tokens, m.period_quota_requests,
            m.period_used_tokens, m.period_used_requests, m.period_reset_at, m.period_cycles,
            m.multiplier_schedules,
            m.token_multiplier, m.request_multiplier
     FROM models m
     JOIN channels c ON c.id = m.channel_id
     WHERE m.enabled = 1 AND c.enabled = 1
       AND m.deleted_at IS NULL AND c.deleted_at IS NULL`,
  );

  // 与网关选路共用同一份 (渠道, 别名) 配对判定，只展示用户实际请求得到的组合。
  const userScope = await getUserScope(user);
  const redeemScopes = await listRedeemScopes(user.id);

  const accessible = models.filter((m) => {
    // 渠道白名单先于公开模型判定：选路阶段的 allowSet 对公开模型一样生效，
    // 这里放开就等于展示「看得见、请求必然 403」的组合。
    if (groupAllowedChannels.length > 0 && !groupAllowedChannels.includes(m.channel_id)) return false;
    if (m.is_public === 1 || m.alias === "*") return true;
    const userHasAlias = userAllowedAliases.includes(m.alias);
    const groupHasAlias = groupAllowedAliases.includes(m.alias);
    if (userHasAlias || groupHasAlias) return true;
    return (userScope !== null && scopeCoversPair(userScope, m.channel_id, m.alias))
      || scopesCoverPair(redeemScopes, m.channel_id, m.alias);
  });

  const now = new Date();
  const data = accessible.map((m) => {
    let periodUsedTokens = m.period_used_tokens;
    let periodUsedRequests = m.period_used_requests;
    let periodResetAt: string | null = m.period_reset_at;
    const mReset = parseStoredUtc(m.period_reset_at);
    if (m.quota_period && mReset && mReset <= now) {
      periodUsedTokens = 0;
      periodUsedRequests = 0;
      const nextReset = new Date(now.getTime() + m.quota_period * 1000);
      periodResetAt = nextReset.toISOString();
    }

    const selfQuota = m.quota_mode === "independent" || m.quota_mode === "dual";
    const periodEnabled = selfQuota && m.quota_period;
    const periods = selfQuota
      ? resolveStoredPeriodCycles(m.period_cycles, m).map(toPeriodQuotaEntry)
      : [];
    // 展示当下实际生效的倍率：分时倍率命中时覆盖基础倍率。
    const schedules = parseMultiplierSchedules(m.multiplier_schedules);
    const effective = resolveEffectiveMultiplier(m.token_multiplier ?? 1, m.request_multiplier ?? 1, schedules, now);

    return {
      alias: m.alias,
      real_model: m.real_model,
      channel_id: m.channel_id,
      channel_name: m.channel_name,
      quota_mode: m.quota_mode,
      token_multiplier: m.token_multiplier ?? 1,
      request_multiplier: m.request_multiplier ?? 1,
      effective_token_multiplier: effective.token_multiplier,
      effective_request_multiplier: effective.request_multiplier,
      multiplier_schedule_applied: effective.schedule_applied,
      quota_requests: selfQuota ? m.quota_requests : null,
      quota_tokens: selfQuota ? m.quota_tokens : null,
      used_requests: selfQuota ? periodUsedRequests : null,
      used_tokens: selfQuota ? periodUsedTokens : null,
      remaining_requests: selfQuota && m.quota_requests !== null ? Math.max(0, m.quota_requests - periodUsedRequests) : null,
      remaining_tokens: selfQuota && m.quota_tokens !== null ? Math.max(0, m.quota_tokens - periodUsedTokens) : null,
      quota_period: selfQuota ? m.quota_period : null,
      period_label: periodEnabled ? formatPeriodLabel(m.quota_period as number) : null,
      period_quota_requests: periodEnabled ? m.period_quota_requests : null,
      period_quota_tokens: periodEnabled ? m.period_quota_tokens : null,
      period_used_requests: periodEnabled && m.period_quota_requests != null ? periodUsedRequests : null,
      period_used_tokens: periodEnabled && m.period_quota_tokens != null ? periodUsedTokens : null,
      period_remaining_requests: periodEnabled && m.period_quota_requests != null ? Math.max(0, m.period_quota_requests - periodUsedRequests) : null,
      period_remaining_tokens: periodEnabled && m.period_quota_tokens != null ? Math.max(0, m.period_quota_tokens - periodUsedTokens) : null,
      period_reset_at: periodEnabled ? periodResetAt : null,
      periods,
    };
  });

  return jsonOk({ data });
}

export const dynamic = "force-dynamic";

import { gatewayDb, type DbUser } from "@/lib/core/db";
import { ensureUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";
import { modelGateFeatures } from "@/lib/core/features";

function formatPeriodLabel(seconds: number): string {
  if (seconds === 3600) return "每小时";
  if (seconds === 86400) return "每日";
  if (seconds === 604800) return "每周";
  if (seconds === 2592000) return "每月";
  if (seconds >= 86400) return `每 ${Math.round(seconds / 86400)} 天`;
  if (seconds >= 3600) return `每 ${Math.round(seconds / 3600)} 小时`;
  return `每 ${seconds} 秒`;
}

export async function GET(request: Request) {
  const guard = ensureUser(request);
  if ("error" in guard) return guard.error;

  const user = guard.auth.user;
  const group = user.group_id
    ? (gatewayDb.prepare("SELECT allowed_model_aliases, allowed_channel_ids FROM groups WHERE id = ? AND enabled = 1 AND deleted_at IS NULL").get(user.group_id) as { allowed_model_aliases: string; allowed_channel_ids: string } | undefined)
    : null;

  const userAllowedAliases: string[] = (() => { try { return JSON.parse(user.allowed_model_aliases); } catch { return []; } })();
  const groupAllowedAliases: string[] = (() => { try { return group ? JSON.parse(group.allowed_model_aliases) : []; } catch { return []; } })();
  const groupAllowedChannels: number[] = (() => { try { return group ? JSON.parse(group.allowed_channel_ids) : []; } catch { return []; } })();

  const models = gatewayDb.prepare(
    `SELECT m.id, m.alias, m.real_model, m.channel_id, m.is_public, m.quota_mode,
            m.quota_tokens, m.quota_requests, m.quota_period,
            m.period_quota_tokens, m.period_quota_requests,
            m.period_used_tokens, m.period_used_requests, m.period_reset_at
     FROM models m
     JOIN channels c ON c.id = m.channel_id
     WHERE (m.quota_mode = 'independent' OR m.quota_mode = 'bypass_group')
       AND m.enabled = 1 AND c.enabled = 1
       AND m.deleted_at IS NULL AND c.deleted_at IS NULL`,
  ).all() as Array<{
    id: number;
    alias: string;
    real_model: string;
    channel_id: number;
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
  }>;

  const accessible = models.filter((m) => {
    if (groupAllowedChannels.length > 0 && !groupAllowedChannels.includes(m.channel_id)) return false;
    if (m.is_public === 1) return true;
    if (m.alias === "*") return true;
    const userHasAlias = userAllowedAliases.includes(m.alias);
    const groupHasAlias = groupAllowedAliases.includes(m.alias);
    return userHasAlias || groupHasAlias;
  });

  const now = new Date();
  const data = accessible.map((m) => {
    let periodUsedTokens = m.period_used_tokens;
    let periodUsedRequests = m.period_used_requests;
    if (m.quota_period && m.period_reset_at && new Date(m.period_reset_at) <= now) {
      periodUsedTokens = 0;
      periodUsedRequests = 0;
    }

    return {
      alias: m.alias,
      real_model: m.real_model,
      quota_mode: m.quota_mode,
      quota_requests: m.quota_requests,
      quota_tokens: m.quota_tokens,
      used_requests: periodUsedRequests,
      used_tokens: periodUsedTokens,
      remaining_requests: m.quota_requests !== null ? Math.max(0, m.quota_requests - periodUsedRequests) : null,
      remaining_tokens: m.quota_tokens !== null ? Math.max(0, m.quota_tokens - periodUsedTokens) : null,
      quota_period: m.quota_period,
      period_label: m.quota_period ? formatPeriodLabel(m.quota_period) : null,
      period_quota_requests: m.period_quota_requests,
      period_quota_tokens: m.period_quota_tokens,
      period_used_requests: m.period_quota_requests != null ? periodUsedRequests : null,
      period_used_tokens: m.period_quota_tokens != null ? periodUsedTokens : null,
      period_remaining_requests: m.period_quota_requests != null ? Math.max(0, m.period_quota_requests - periodUsedRequests) : null,
      period_remaining_tokens: m.period_quota_tokens != null ? Math.max(0, m.period_quota_tokens - periodUsedTokens) : null,
      period_reset_at: m.quota_period ? m.period_reset_at : null,
    };
  });

  return jsonOk({ data });
}

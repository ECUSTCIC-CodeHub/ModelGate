export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
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
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const totalUsers = (gatewayDb.prepare("SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL AND enabled = 1").get() as { count: number }).count;
  const totalKeys = (gatewayDb.prepare("SELECT COUNT(*) AS count FROM keys WHERE deleted_at IS NULL").get() as { count: number }).count;

  const groupRows = gatewayDb.prepare(
    `SELECT g.id, g.name, g.quota_tokens, g.quota_requests, g.quota_period,
            g.period_quota_tokens, g.period_quota_requests,
            COALESCE(u_stats.used_tokens, 0) AS used_tokens,
            COALESCE(u_stats.used_requests, 0) AS used_requests,
            COALESCE(u_stats.period_used_tokens, 0) AS period_used_tokens,
            COALESCE(u_stats.period_used_requests, 0) AS period_used_requests,
            COALESCE(u_stats.user_count, 0) AS user_count
     FROM groups g
     LEFT JOIN (
       SELECT group_id,
              SUM(used_tokens) AS used_tokens,
              SUM(used_requests) AS used_requests,
              SUM(period_used_tokens) AS period_used_tokens,
              SUM(period_used_requests) AS period_used_requests,
              COUNT(*) AS user_count
       FROM users WHERE deleted_at IS NULL AND enabled = 1
       GROUP BY group_id
     ) u_stats ON u_stats.group_id = g.id
     WHERE g.deleted_at IS NULL AND g.enabled = 1`,
  ).all() as Array<{
    id: number;
    name: string;
    quota_tokens: number | null;
    quota_requests: number | null;
    quota_period: number | null;
    period_quota_tokens: number | null;
    period_quota_requests: number | null;
    used_tokens: number;
    used_requests: number;
    period_used_tokens: number;
    period_used_requests: number;
    user_count: number;
  }>;

  const groups = groupRows.map((g) => ({
    id: g.id,
    name: g.name,
    user_count: g.user_count,
    quota_tokens: g.quota_tokens,
    quota_requests: g.quota_requests,
    used_tokens: g.used_tokens,
    used_requests: g.used_requests,
    remaining_tokens: g.quota_tokens !== null ? Math.max(0, g.quota_tokens - g.used_tokens) : null,
    remaining_requests: g.quota_requests !== null ? Math.max(0, g.quota_requests - g.used_requests) : null,
    quota_period: modelGateFeatures.periodQuota ? g.quota_period : null,
    period_label: modelGateFeatures.periodQuota && g.quota_period ? formatPeriodLabel(g.quota_period) : null,
    period_quota_tokens: modelGateFeatures.periodQuota ? g.period_quota_tokens : null,
    period_quota_requests: modelGateFeatures.periodQuota ? g.period_quota_requests : null,
    period_used_tokens: modelGateFeatures.periodQuota ? g.period_used_tokens : null,
    period_used_requests: modelGateFeatures.periodQuota ? g.period_used_requests : null,
    period_remaining_tokens: modelGateFeatures.periodQuota && g.period_quota_tokens !== null ? Math.max(0, g.period_quota_tokens - g.period_used_tokens) : null,
    period_remaining_requests: modelGateFeatures.periodQuota && g.period_quota_requests !== null ? Math.max(0, g.period_quota_requests - g.period_used_requests) : null,
  }));

  const modelRows = gatewayDb.prepare(
    `SELECT m.id, m.alias, m.real_model, m.quota_mode,
            m.quota_tokens, m.quota_requests, m.quota_period,
            m.period_quota_tokens, m.period_quota_requests,
            m.period_used_tokens, m.period_used_requests, m.period_reset_at,
            c.name AS channel_name
     FROM models m
     JOIN channels c ON c.id = m.channel_id
     WHERE (m.quota_mode = 'independent' OR m.quota_mode = 'bypass_group')
       AND m.enabled = 1 AND c.enabled = 1
       AND m.deleted_at IS NULL AND c.deleted_at IS NULL`,
  ).all() as Array<{
    id: number;
    alias: string;
    real_model: string;
    quota_mode: string;
    quota_tokens: number | null;
    quota_requests: number | null;
    quota_period: number | null;
    period_quota_tokens: number | null;
    period_quota_requests: number | null;
    period_used_tokens: number;
    period_used_requests: number;
    period_reset_at: string | null;
    channel_name: string;
  }>;

  const now = new Date();
  const models = modelRows.map((m) => {
    let periodUsedTokens = m.period_used_tokens;
    let periodUsedRequests = m.period_used_requests;
    if (m.quota_period && m.period_reset_at && new Date(m.period_reset_at) <= now) {
      periodUsedTokens = 0;
      periodUsedRequests = 0;
    }

    return {
      id: m.id,
      alias: m.alias,
      real_model: m.real_model,
      channel_name: m.channel_name,
      quota_mode: m.quota_mode,
      quota_requests: m.quota_requests,
      quota_tokens: m.quota_tokens,
      used_requests: m.quota_mode === "independent" ? periodUsedRequests : null,
      used_tokens: m.quota_mode === "independent" ? periodUsedTokens : null,
      remaining_requests: m.quota_mode === "independent" && m.quota_requests !== null ? Math.max(0, m.quota_requests - periodUsedRequests) : null,
      remaining_tokens: m.quota_mode === "independent" && m.quota_tokens !== null ? Math.max(0, m.quota_tokens - periodUsedTokens) : null,
      quota_period: modelGateFeatures.periodQuota ? m.quota_period : null,
      period_label: modelGateFeatures.periodQuota && m.quota_period ? formatPeriodLabel(m.quota_period) : null,
      period_quota_requests: modelGateFeatures.periodQuota ? m.period_quota_requests : null,
      period_quota_tokens: modelGateFeatures.periodQuota ? m.period_quota_tokens : null,
      period_used_requests: modelGateFeatures.periodQuota && m.quota_mode === "independent" && m.period_quota_requests != null ? periodUsedRequests : null,
      period_used_tokens: modelGateFeatures.periodQuota && m.quota_mode === "independent" && m.period_quota_tokens != null ? periodUsedTokens : null,
      period_remaining_requests: modelGateFeatures.periodQuota && m.quota_mode === "independent" && m.period_quota_requests != null ? Math.max(0, m.period_quota_requests - periodUsedRequests) : null,
      period_remaining_tokens: modelGateFeatures.periodQuota && m.quota_mode === "independent" && m.period_quota_tokens != null ? Math.max(0, m.period_quota_tokens - periodUsedTokens) : null,
      period_reset_at: modelGateFeatures.periodQuota && m.quota_period ? m.period_reset_at : null,
    };
  });

  return jsonOk({
    total_users: totalUsers,
    total_keys: totalKeys,
    groups,
    models,
  });
}

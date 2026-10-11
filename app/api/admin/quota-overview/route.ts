export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";
import { modelGateFeatures } from "@/lib/core/features";
import { parsePeriodCycles } from "@/lib/gateway/period-cycles";
import { toPeriodQuotaEntry } from "@/lib/gateway/quota";

export async function GET(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const totalUsers = ((await gatewayDb.queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL AND enabled = 1"))!).count;
  const totalKeys = ((await gatewayDb.queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM `keys` WHERE deleted_at IS NULL"))!).count;

  const groupRows = await gatewayDb.query<{
    id: number;
    name: string;
    qps: number;
    rpm: number;
    tpm: number;
    quota_tokens: number | null;
    quota_requests: number | null;
    period_cycles: string | null;
    user_count: number;
  }>(
    `SELECT g.id, g.name, g.qps, g.rpm, g.tpm,
            g.quota_tokens, g.quota_requests, g.period_cycles,
            COALESCE(u_stats.user_count, 0) AS user_count
     FROM \`groups\` g
     LEFT JOIN (
       SELECT group_id, COUNT(*) AS user_count
       FROM users WHERE deleted_at IS NULL AND enabled = 1
       GROUP BY group_id
     ) u_stats ON u_stats.group_id = g.id
     WHERE g.deleted_at IS NULL AND g.enabled = 1`,
  );

  const channelRows = await gatewayDb.query<{
    id: number;
    name: string;
    quota_tokens: number | null;
    quota_requests: number | null;
    period_used_tokens: number;
    period_used_requests: number;
    period_cycles: string | null;
    model_count: number;
  }>(
    `SELECT c.id, c.name, c.quota_tokens, c.quota_requests,
            c.period_used_tokens, c.period_used_requests, c.period_cycles,
            COALESCE(m_stats.model_count, 0) AS model_count
     FROM channels c
     LEFT JOIN (
       SELECT channel_id, COUNT(*) AS model_count
       FROM models WHERE deleted_at IS NULL AND enabled = 1
       GROUP BY channel_id
     ) m_stats ON m_stats.channel_id = c.id
     WHERE c.deleted_at IS NULL AND c.enabled = 1`,
  );

  const channels = channelRows.map((c) => {
    // 渠道的 quota_tokens / quota_requests 是「总配额」，计数器是 period_used_*，
    // 至今仍在生效且界面上可编辑（见 checkChannelQuota）。该计数器不随窗口重置。
    const usedTokens = c.period_used_tokens;
    const usedRequests = c.period_used_requests;

    return {
      id: c.id,
      name: c.name,
      model_count: c.model_count,
      quota_tokens: c.quota_tokens,
      quota_requests: c.quota_requests,
      used_tokens: c.quota_tokens !== null ? usedTokens : null,
      used_requests: c.quota_requests !== null ? usedRequests : null,
      remaining_tokens: c.quota_tokens !== null ? Math.max(0, c.quota_tokens - usedTokens) : null,
      remaining_requests: c.quota_requests !== null ? Math.max(0, c.quota_requests - usedRequests) : null,
      periods: parsePeriodCycles(c.period_cycles).map(toPeriodQuotaEntry),
    };
  });

  const groups = groupRows.map((g) => ({
    id: g.id,
    name: g.name,
    user_count: g.user_count,
    rpm: g.rpm,
    qps: g.qps,
    tpm: g.tpm,
    quota_tokens: g.quota_tokens,
    quota_requests: g.quota_requests,
    // 组不持有运行时计数，只展示定义值
    periods: (modelGateFeatures.periodQuota ? parsePeriodCycles(g.period_cycles) : []).map(toPeriodQuotaEntry),
  }));

  const modelRows = await gatewayDb.query<{
    id: number;
    alias: string;
    real_model: string;
    quota_mode: string;
    quota_tokens: number | null;
    quota_requests: number | null;
    period_used_tokens: number;
    period_used_requests: number;
    period_cycles: string | null;
    channel_name: string;
  }>(
    `SELECT m.id, m.alias, m.real_model, m.quota_mode,
            m.quota_tokens, m.quota_requests,
            m.period_used_tokens, m.period_used_requests, m.period_cycles,
            c.name AS channel_name
     FROM models m
     JOIN channels c ON c.id = m.channel_id
     WHERE (m.quota_mode = 'independent' OR m.quota_mode = 'bypass_group' OR m.quota_mode = 'dual')
       AND m.enabled = 1 AND c.enabled = 1
       AND m.deleted_at IS NULL AND c.deleted_at IS NULL`,
  );

  const models = modelRows.map((m) => {
    const selfQuota = m.quota_mode === "independent" || m.quota_mode === "dual";
    // 模型的 quota_tokens / quota_requests 同为「总配额」，计数器是 period_used_*。
    const usedTokens = m.period_used_tokens;
    const usedRequests = m.period_used_requests;

    return {
      id: m.id,
      alias: m.alias,
      real_model: m.real_model,
      channel_name: m.channel_name,
      quota_mode: m.quota_mode,
      quota_requests: m.quota_requests,
      quota_tokens: m.quota_tokens,
      used_requests: selfQuota ? usedRequests : null,
      used_tokens: selfQuota ? usedTokens : null,
      remaining_requests: selfQuota && m.quota_requests !== null ? Math.max(0, m.quota_requests - usedRequests) : null,
      remaining_tokens: selfQuota && m.quota_tokens !== null ? Math.max(0, m.quota_tokens - usedTokens) : null,
      periods: selfQuota ? parsePeriodCycles(m.period_cycles).map(toPeriodQuotaEntry) : [],
    };
  });

  return jsonOk({
    total_users: totalUsers,
    total_keys: totalKeys,
    groups,
    channels,
    models,
  });
}

import { gatewayDb } from "@/lib/core/db";
import { modelGateFeatures } from "@/lib/core/features";

export type ChannelQuotaInfo = {
  remaining_requests: number | null;
  remaining_tokens: number | null;
  period_remaining_requests: number | null;
  period_remaining_tokens: number | null;
  period_reset_at: string | null;
};

function ensureChannelPeriodReset(channelId: number, period: number, resetAt: string | null): { period_used_tokens: number; period_used_requests: number; period_reset_at: string } {
  const now = new Date();
  if (resetAt && new Date(resetAt) > now) {
    return gatewayDb
      .prepare("SELECT period_used_tokens, period_used_requests, period_reset_at FROM channels WHERE id = ?")
      .get(channelId) as { period_used_tokens: number; period_used_requests: number; period_reset_at: string };
  }
  const nextReset = new Date(now.getTime() + period * 1000).toISOString();
  const result = gatewayDb
    .prepare(
      `UPDATE channels
       SET period_used_tokens = 0, period_used_requests = 0, period_reset_at = ?
       WHERE id = ? AND (period_reset_at IS NULL OR period_reset_at <= ?)`,
    )
    .run(nextReset, channelId, now.toISOString());
  if (result.changes > 0) {
    return { period_used_tokens: 0, period_used_requests: 0, period_reset_at: nextReset };
  }
  return gatewayDb
    .prepare("SELECT period_used_tokens, period_used_requests, period_reset_at FROM channels WHERE id = ?")
    .get(channelId) as { period_used_tokens: number; period_used_requests: number; period_reset_at: string };
}

export function checkChannelQuota(channelId: number, estimatedTokens: number): { ok: false; reason: string } | { ok: true; quota: ChannelQuotaInfo } {
  const channel = gatewayDb
    .prepare(`SELECT id, quota_tokens, quota_requests, quota_period,
              period_quota_tokens, period_quota_requests,
              period_used_tokens, period_used_requests, period_reset_at
              FROM channels WHERE id = ? AND deleted_at IS NULL`)
    .get(channelId) as
    | {
        id: number;
        quota_tokens: number | null;
        quota_requests: number | null;
        quota_period: number | null;
        period_quota_tokens: number | null;
        period_quota_requests: number | null;
        period_used_tokens: number;
        period_used_requests: number;
        period_reset_at: string | null;
      }
    | undefined;

  if (!channel) {
    return { ok: false, reason: "渠道不存在" };
  }

  const quota: ChannelQuotaInfo = {
    remaining_requests: channel.quota_requests !== null ? Math.max(0, channel.quota_requests - channel.period_used_requests) : null,
    remaining_tokens: channel.quota_tokens !== null ? Math.max(0, channel.quota_tokens - channel.period_used_tokens) : null,
    period_remaining_requests: null,
    period_remaining_tokens: null,
    period_reset_at: null,
  };

  if (channel.quota_requests !== null && channel.period_used_requests >= channel.quota_requests) {
    return { ok: false, reason: "渠道请求配额已用尽" };
  }

  if (channel.quota_tokens !== null && channel.period_used_tokens + estimatedTokens > channel.quota_tokens) {
    return { ok: false, reason: "渠道 Token 配额已用尽" };
  }

  if (modelGateFeatures.periodQuota && channel.quota_period) {
    const period = ensureChannelPeriodReset(channelId, channel.quota_period, channel.period_reset_at);
    quota.period_reset_at = period.period_reset_at;

    if (channel.period_quota_requests !== null) {
      quota.period_remaining_requests = Math.max(0, channel.period_quota_requests - period.period_used_requests);
      if (period.period_used_requests >= channel.period_quota_requests) {
        return { ok: false, reason: "渠道周期请求配额已用尽" };
      }
    }

    if (channel.period_quota_tokens !== null) {
      quota.period_remaining_tokens = Math.max(0, channel.period_quota_tokens - period.period_used_tokens);
      if (period.period_used_tokens + estimatedTokens > channel.period_quota_tokens) {
        return { ok: false, reason: "渠道周期 Token 配额已用尽" };
      }
    }
  }

  return { ok: true, quota };
}

export function appendChannelQuotaHeaders(headers: Record<string, string>, quota: ChannelQuotaInfo) {
  if (quota.remaining_requests !== null) {
    headers["X-Channel-Quota-Requests-Remaining"] = String(quota.remaining_requests);
  }
  if (quota.remaining_tokens !== null) {
    headers["X-Channel-Quota-Tokens-Remaining"] = String(quota.remaining_tokens);
  }
  if (quota.period_remaining_requests !== null) {
    headers["X-Channel-Period-Quota-Requests-Remaining"] = String(quota.period_remaining_requests);
  }
  if (quota.period_remaining_tokens !== null) {
    headers["X-Channel-Period-Quota-Tokens-Remaining"] = String(quota.period_remaining_tokens);
  }
  if (quota.period_reset_at) {
    headers["X-Channel-Period-Quota-Reset"] = quota.period_reset_at;
  }
}

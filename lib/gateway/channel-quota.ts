import { gatewayDb } from "@/lib/core/db";
import { modelGateFeatures } from "@/lib/core/features";
import { parsePeriodCycles } from "@/lib/gateway/period-cycles";
import { ensureCycleResets } from "@/lib/gateway/period-cycles-reset";
import { findExceededCycle, toPeriodQuotaEntry, type PeriodQuotaEntry } from "@/lib/gateway/quota";

export type ChannelQuotaInfo = {
  remaining_requests: number | null;
  remaining_tokens: number | null;
  periods: PeriodQuotaEntry[];
};

export async function checkChannelQuota(channelId: number, estimatedTokens: number): Promise<{ ok: false; reason: string } | { ok: true; quota: ChannelQuotaInfo }> {
  const channel = await gatewayDb.queryOne<{
    id: number;
    quota_tokens: number | null;
    quota_requests: number | null;
    period_used_tokens: number;
    period_used_requests: number;
    period_cycles: string | null;
  }>(
    `SELECT id, quota_tokens, quota_requests,
              period_used_tokens, period_used_requests, period_cycles
              FROM channels WHERE id = ? AND deleted_at IS NULL`,
    [channelId],
  );

  if (!channel) {
    return { ok: false, reason: "渠道不存在" };
  }

  // period_used_* 是「总配额」（quota_requests / quota_tokens）的累计，仍在写入。
  const legacyUsedTokens = channel.period_used_tokens;
  const legacyUsedRequests = channel.period_used_requests;

  const quota: ChannelQuotaInfo = {
    remaining_requests: channel.quota_requests !== null ? Math.max(0, channel.quota_requests - legacyUsedRequests) : null,
    remaining_tokens: channel.quota_tokens !== null ? Math.max(0, channel.quota_tokens - legacyUsedTokens) : null,
    periods: [],
  };

  if (channel.quota_requests !== null && legacyUsedRequests >= channel.quota_requests) {
    return { ok: false, reason: "渠道请求配额已用尽" };
  }

  if (channel.quota_tokens !== null && legacyUsedTokens + estimatedTokens > channel.quota_tokens) {
    return { ok: false, reason: "渠道 Token 配额已用尽" };
  }

  if (modelGateFeatures.periodQuota) {
    // 渠道的旧单档列已停止写入且不再参与读取，周期档只认 period_cycles。
    const cycles = parsePeriodCycles(channel.period_cycles);
    if (cycles.length > 0) {
      const reset = await ensureCycleResets("channels", channelId, cycles, undefined, channel.period_cycles);
      quota.periods = reset.map(toPeriodQuotaEntry);
      const exceeded = findExceededCycle(reset, estimatedTokens);
      if (exceeded) {
        return { ok: false, reason: exceeded.reason.replace("周期", "渠道周期") };
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
  const head = quota.periods[0];
  if (head) {
    if (head.remaining_requests !== null) {
      headers["X-Channel-Period-Quota-Requests-Remaining"] = String(head.remaining_requests);
    }
    if (head.remaining_tokens !== null) {
      headers["X-Channel-Period-Quota-Tokens-Remaining"] = String(head.remaining_tokens);
    }
    if (head.reset_at) {
      headers["X-Channel-Period-Quota-Reset"] = head.reset_at;
    }
  }
  for (const period of quota.periods) {
    if (period.remaining_requests !== null) {
      headers[`X-Channel-Period-Quota-Requests-Remaining-${period.id}`] = String(period.remaining_requests);
    }
    if (period.remaining_tokens !== null) {
      headers[`X-Channel-Period-Quota-Tokens-Remaining-${period.id}`] = String(period.remaining_tokens);
    }
    if (period.reset_at) {
      headers[`X-Channel-Period-Quota-Reset-${period.id}`] = period.reset_at;
    }
  }
}

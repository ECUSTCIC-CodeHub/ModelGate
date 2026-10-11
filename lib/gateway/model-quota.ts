import { gatewayDb } from "@/lib/core/db";
import { modelGateFeatures } from "@/lib/core/features";
import { parsePeriodCycles } from "@/lib/gateway/period-cycles";
import { ensureCycleResets } from "@/lib/gateway/period-cycles-reset";
import { findExceededCycle, toPeriodQuotaEntry, type PeriodQuotaEntry } from "@/lib/gateway/quota";

export type ModelQuotaInfo = {
  remaining_requests: number | null;
  remaining_tokens: number | null;
  periods: PeriodQuotaEntry[];
};

export async function checkModelQuota(modelId: number, estimatedTokens: number): Promise<{ ok: false; reason: string } | { ok: true; quota: ModelQuotaInfo }> {
  const model = await gatewayDb.queryOne<{
    id: number;
    quota_tokens: number | null;
    quota_requests: number | null;
    period_used_tokens: number;
    period_used_requests: number;
    period_cycles: string | null;
  }>(
    `SELECT id, quota_tokens, quota_requests,
              period_used_tokens, period_used_requests, period_cycles
              FROM models WHERE id = ? AND deleted_at IS NULL`,
    [modelId],
  );

  if (!model) {
    return { ok: false, reason: "模型不存在" };
  }

  const quota: ModelQuotaInfo = {
    remaining_requests: model.quota_requests !== null ? Math.max(0, model.quota_requests - model.period_used_requests) : null,
    remaining_tokens: model.quota_tokens !== null ? Math.max(0, model.quota_tokens - model.period_used_tokens) : null,
    periods: [],
  };

  if (model.quota_requests !== null && model.period_used_requests >= model.quota_requests) {
    return { ok: false, reason: "模型请求配额已用尽" };
  }

  if (model.quota_tokens !== null && model.period_used_tokens + estimatedTokens > model.quota_tokens) {
    return { ok: false, reason: "模型 Token 配额已用尽" };
  }

  if (modelGateFeatures.periodQuota) {
    // 模型的旧单档列已停止写入且不再参与读取，周期档只认 period_cycles。
    const cycles = parsePeriodCycles(model.period_cycles);
    if (cycles.length > 0) {
      const reset = await ensureCycleResets("models", modelId, cycles, undefined, model.period_cycles);
      quota.periods = reset.map(toPeriodQuotaEntry);
      const exceeded = findExceededCycle(reset, estimatedTokens);
      if (exceeded) {
        return { ok: false, reason: exceeded.reason.replace("周期", "模型周期") };
      }
    }
  }

  return { ok: true, quota };
}

export function appendModelQuotaHeaders(headers: Record<string, string>, quota: ModelQuotaInfo) {
  if (quota.remaining_requests !== null) {
    headers["X-Model-Quota-Requests-Remaining"] = String(quota.remaining_requests);
  }
  if (quota.remaining_tokens !== null) {
    headers["X-Model-Quota-Tokens-Remaining"] = String(quota.remaining_tokens);
  }
  const head = quota.periods[0];
  if (head) {
    if (head.remaining_requests !== null) {
      headers["X-Model-Period-Quota-Requests-Remaining"] = String(head.remaining_requests);
    }
    if (head.remaining_tokens !== null) {
      headers["X-Model-Period-Quota-Tokens-Remaining"] = String(head.remaining_tokens);
    }
    if (head.reset_at) {
      headers["X-Model-Period-Quota-Reset"] = head.reset_at;
    }
  }
  for (const period of quota.periods) {
    if (period.remaining_requests !== null) {
      headers[`X-Model-Period-Quota-Requests-Remaining-${period.id}`] = String(period.remaining_requests);
    }
    if (period.remaining_tokens !== null) {
      headers[`X-Model-Period-Quota-Tokens-Remaining-${period.id}`] = String(period.remaining_tokens);
    }
    if (period.reset_at) {
      headers[`X-Model-Period-Quota-Reset-${period.id}`] = period.reset_at;
    }
  }
}

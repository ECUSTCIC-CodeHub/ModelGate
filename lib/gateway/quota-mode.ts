import type { DbChannel, DbModel, QuotaMode } from "@/lib/core/db/types";

export const QUOTA_MODES = ["follow_group", "bypass_group", "independent", "dual"] as const;

type QuotaScope = {
  model: Pick<DbModel, "quota_mode">;
  channel: Pick<DbChannel, "quota_mode">;
};

function normalizeQuotaMode(mode: string | null | undefined, fallback: QuotaMode): QuotaMode {
  return (QUOTA_MODES as readonly string[]).includes(mode ?? "") ? (mode as QuotaMode) : fallback;
}

// 读侧把未知取值（NULL、空串、历史脏值）统一收敛到 dual，
// 避免脏值把渠道自身配额静默关掉。
export function normalizeChannelQuotaMode(mode: string | null | undefined): QuotaMode {
  return normalizeQuotaMode(mode, "dual");
}

// 模型级兜底值是 follow_group：收敛后的取值同时用于配额检查与前端分组。
export function normalizeModelQuotaMode(mode: string | null | undefined): QuotaMode {
  return normalizeQuotaMode(mode, "follow_group");
}

// 单级配额模式是否跳过用户/组配额与速率限制。
export function isBypassQuotaMode(mode: string | null | undefined): boolean {
  return mode === "bypass_group" || mode === "independent";
}

// 路由是否跳过用户/组配额与速率限制：模型或渠道任一为 bypass_group / independent 即跳过。
// 两级的模式独立配置，任一级要求绕过就按绕过执行，避免渠道侧的放行被模型侧的默认值吃掉。
export function bypassesUserLimits(scope: QuotaScope): boolean {
  return isBypassQuotaMode(scope.model.quota_mode) || isBypassQuotaMode(scope.channel.quota_mode);
}

// 某级自身配额是否参与判定：仅 independent / dual。
function usesSelfQuota(mode: string | null | undefined, fallback: QuotaMode): boolean {
  const normalized = normalizeQuotaMode(mode, fallback);
  return normalized === "independent" || normalized === "dual";
}

// 渠道自身配额（quota_* 与周期档）是否生效：仅 independent / dual 会检查并返回外露额度。
export function usesChannelSelfQuota(mode: string | null | undefined): boolean {
  return usesSelfQuota(mode, "dual");
}

// 模型自身配额是否生效，与渠道侧对称，供配额预检直接按模式判定。
export function usesModelSelfQuota(mode: string | null | undefined): boolean {
  return usesSelfQuota(mode, "follow_group");
}

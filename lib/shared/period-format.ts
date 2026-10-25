import { formatNumber, formatTokenCount } from "@/lib/shared/utils";

export const PERIOD_PRESETS = [
  { label: "每小时", value: "3600" },
  { label: "每日", value: "86400" },
  { label: "每周", value: "604800" },
  { label: "每月", value: "2592000" },
] as const;

// 每档一行，请求与 Token 合并；「/」前为剩余、后为限额，与配额页口径一致。
// 表格单元格用 periodQuotaLines 换行渲染，title 提示用 summarizePeriodQuota 单行汇总。
// 额度 -1 = 显式不限制，不带可用量；null = 未配置（继承且上游无配置）。
function quotaPart(label: string, quota: number | null, remaining: number | null, format: (value: number) => string): string | null {
  if (quota === null) return null;
  if (quota < 0) return `${label} 不限制`;
  return `${label} ${format(remaining ?? 0)}/${format(quota)}`;
}

export function periodQuotaLines(
  periods: Array<{
    period_label: string;
    quota_requests: number | null;
    quota_tokens: number | null;
    remaining_requests: number | null;
    remaining_tokens: number | null;
  }>,
): string[] {
  return periods.flatMap((p) => {
    const parts = [
      quotaPart("请求", p.quota_requests, p.remaining_requests, formatNumber),
      quotaPart("Token", p.quota_tokens, p.remaining_tokens, formatTokenCount),
    ].filter((part): part is string => part !== null);
    return parts.length === 0 ? [] : [`${p.period_label} ${parts.join(" · ")}`];
  });
}

export function summarizePeriodQuota(periods: Parameters<typeof periodQuotaLines>[0]): string {
  const lines = periodQuotaLines(periods);
  return lines.length === 0 ? "-" : lines.join("，");
}

export function formatPeriodLabel(seconds: number): string {
  if (seconds === 3600) return "每小时";
  if (seconds === 86400) return "每日";
  if (seconds === 604800) return "每周";
  if (seconds === 2592000) return "每月";
  if (seconds >= 86400) return `每 ${Math.round(seconds / 86400)} 天`;
  if (seconds >= 3600) return `每 ${Math.round(seconds / 3600)} 小时`;
  if (seconds >= 60) return `每 ${Math.round(seconds / 60)} 分钟`;
  return `每 ${seconds} 秒`;
}

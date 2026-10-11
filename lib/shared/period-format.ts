export const PERIOD_PRESETS = [
  { label: "每小时", value: "3600" },
  { label: "每日", value: "86400" },
  { label: "每周", value: "604800" },
  { label: "每月", value: "2592000" },
] as const;

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

// 秒数 → 预设 value；不是预设时返回 "custom"，null/<=0 返回 ""。
export function periodToPreset(value: number | null): string {
  if (value === null || value <= 0) return "";
  return PERIOD_PRESETS.some((preset) => Number(preset.value) === value) ? String(value) : "custom";
}

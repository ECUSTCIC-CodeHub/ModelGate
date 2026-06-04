export function formatLimit(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  if (value < 0) return "∞";
  const display = Math.abs(value - Math.round(value)) < 1e-6 ? Math.round(value) : value;
  const abs = Math.abs(display);
  if (abs >= 1_000_000_000) return `${(display / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(display / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(display / 1_000).toFixed(1)}k`;
  return String(display);
}

export function periodExpired(resetAt: string | null | undefined) {
  if (!resetAt) return false;
  return new Date(resetAt) <= new Date();
}

export function periodLabel(seconds: number | null | undefined) {
  if (!seconds || seconds <= 0) return "";
  if (seconds === 3600) return "每小时";
  if (seconds === 86400) return "每日";
  if (seconds === 604800) return "每周";
  if (seconds === 2592000) return "每月";
  if (seconds >= 86400) return `每${Math.round(seconds / 86400)}天`;
  if (seconds >= 3600) return `每${Math.round(seconds / 3600)}时`;
  return `每${seconds}秒`;
}

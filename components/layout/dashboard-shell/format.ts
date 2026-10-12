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

// 金额/速率限额里 -1 表示不限制，这类行不该占位展示。
// 写成类型谓词：调用处取反后即可直接把值当 number 使用。
export function isUnlimited(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || value < 0;
}

// 数据库存的是裸 UTC 的 "YYYY-MM-DD HH:MM:SS"，而 new Date("2026-10-12 03:00:00")
// 会被 V8 按本地时区解析，东八区下会差 8 小时。这里补上 T/Z 明确按 UTC 解析。
export function parseStoredUtc(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const withZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 剩余时间的粗粒度描述，只用于悬浮提示。
export function formatResetIn(resetAt: string | null | undefined): string | null {
  const target = parseStoredUtc(resetAt);
  if (!target) return null;
  const diffMs = target.getTime() - Date.now();
  if (diffMs <= 0) return "即将重置";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟后重置`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时后重置`;
  return `${Math.floor(hours / 24)} 天后重置`;
}

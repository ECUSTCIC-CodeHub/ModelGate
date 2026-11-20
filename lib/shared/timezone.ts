// 时区相关的墙上时间换算。用于渠道时段限制与分时倍率：编辑时按用户所选/浏览器时区，
// 存储与运行时判断按 UTC。所有函数纯计算，前后端通用。

// 浏览器时区；取不到时退回 UTC，保证换算始终有确定输入。
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// 构造 DateTimeFormat 比 formatToParts 贵两个数量级，而 wallTimeToUtc 要按分钟扫一整个 UTC 日：
// 按时区缓存，避免每档每次换算都重建上千个实例（档位上限 20 档，换算在点击保存时同步执行）。
const FORMATTER_CACHE_LIMIT = 32;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterInTimeZone(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  // 时区来自下拉框，数量有限；仍设上限，避免被任意字符串撑爆内存
  if (formatters.size >= FORMATTER_CACHE_LIMIT) formatters.clear();
  formatters.set(timeZone, fmt);
  return fmt;
}

// 时区非法或运行时不支持时返回 null：调用方据此判定「换算不可行」，
// 不能伪造 00:00，否则会把换算失败伪装成一次成功的换算。
function partsInTimeZone(date: Date, timeZone: string): { hour: string; minute: string; weekday: string } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatterInTimeZone(timeZone).formatToParts(date);
  } catch {
    return null;
  }
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  return { hour: hour === "24" ? "00" : hour, minute, weekday };
}

const WEEKDAY_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function weekdayToIso(weekday: string): number {
  const idx = WEEKDAY_ORDER.indexOf(weekday);
  return idx === -1 ? 1 : idx === 0 ? 7 : idx; // 0=周日..6=周六 → 1..7（周一..周日）
}

// 把 UTC 的 HH:MM 换算成指定时区的墙上 HH:MM。
export function utcTimeToWall(hhmm: string, timeZone: string, base: Date = new Date()): string | null {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  const dayStart = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
  const utcMs = dayStart + h * 3600_000 + m * 60_000;
  const parts = partsInTimeZone(new Date(utcMs), timeZone);
  return parts ? `${parts.hour}:${parts.minute}` : null;
}

// 把某时区的墙上 HH:MM 换算成 UTC 的 HH:MM；dayShift 表示相对该时区当日的星期偏移（-1/0/1）。
export function wallTimeToUtc(hhmm: string, timeZone: string, base: Date = new Date()): { utc: string; dayShift: number } | null {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  const dayStart = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
  const target = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  let best: { utcMs: number; tzWeekday: number } | null = null;
  // 以 base 当天 UTC 日起点为参考，按 1 分钟步长扫描一个 UTC 日，找墙上时间匹配的候选。
  for (let off = 0; off < 86400_000; off += 60_000) {
    const parts = partsInTimeZone(new Date(dayStart + off), timeZone);
    if (!parts) continue;
    if (`${parts.hour}:${parts.minute}` === target) {
      best = { utcMs: off, tzWeekday: weekdayToIso(parts.weekday) };
      break;
    }
  }
  if (!best) return null;
  const utcDate = new Date(dayStart + best.utcMs);
  const utc = `${String(utcDate.getUTCHours()).padStart(2, "0")}:${String(utcDate.getUTCMinutes()).padStart(2, "0")}`;
  // dayShift：匹配时刻的 UTC 星期 − 该时刻在所选时区下的星期（用户选「周一」时，UTC 可能落在周日）。
  const matchedUtcWd = (() => { const d = utcDate.getUTCDay(); return d === 0 ? 7 : d; })();
  const dayShift = ((matchedUtcWd - best.tzWeekday + 7) % 7);
  const signed = dayShift > 3 ? dayShift - 7 : dayShift;
  return { utc, dayShift: signed };
}

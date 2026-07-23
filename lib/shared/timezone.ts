// 时区相关的墙上时间换算。用于渠道时段限制：编辑时按用户所选/浏览器时区，
// 存储与运行时判断按 UTC。所有函数纯计算，前后端通用。

function partsInTimeZone(date: Date, timeZone: string): { hour: string; minute: string; weekday: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  try {
    return { hour: hour === "24" ? "00" : hour, minute, weekday };
  } catch {
    return { hour: "00", minute: "00", weekday: "" };
  }
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
  try {
    const { hour, minute } = partsInTimeZone(new Date(utcMs), timeZone);
    return `${hour}:${minute}`;
  } catch {
    return null;
  }
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
    const candidate = new Date(dayStart + off);
    let parts;
    try {
      parts = partsInTimeZone(candidate, timeZone);
    } catch {
      continue;
    }
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

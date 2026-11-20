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
const UNSUPPORTED_CACHE_LIMIT = 32;
const formatters = new Map<string, Intl.DateTimeFormat>();
// 非法时区单独记一份：wallTimeToUtc 要按分钟扫一整天，不记住就会反复构造并抛上千次异常
const unsupportedTimeZones = new Set<string>();

function formatterInTimeZone(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  if (unsupportedTimeZones.has(timeZone)) return null;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    });
  } catch {
    if (unsupportedTimeZones.size >= UNSUPPORTED_CACHE_LIMIT) {
      const oldest = unsupportedTimeZones.values().next().value;
      if (oldest !== undefined) unsupportedTimeZones.delete(oldest);
    }
    unsupportedTimeZones.add(timeZone);
    return null;
  }
  // 时区来自下拉框，数量有限；仍设上限，淘汰最旧一项而不是整表清空，避免周期性抖动重建
  if (formatters.size >= FORMATTER_CACHE_LIMIT) {
    const oldest = formatters.keys().next().value;
    if (oldest !== undefined) formatters.delete(oldest);
  }
  formatters.set(timeZone, fmt);
  return fmt;
}

// 时区非法或运行时不支持时返回 null：调用方据此判定「换算不可行」，
// 不能伪造 00:00，否则会把换算失败伪装成一次成功的换算。
function partsInTimeZone(date: Date, timeZone: string): { hour: string; minute: string; weekday: string } | null {
  const formatter = formatterInTimeZone(timeZone);
  if (!formatter) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatter.formatToParts(date);
  } catch {
    return null;
  }
  const hour = parts.find((p) => p.type === "hour")?.value;
  const minute = parts.find((p) => p.type === "minute")?.value;
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  // 三个字段缺一不可：weekday 缺失时按周一兜底会让 dayShift 静默算错一整天
  if (!hour || !minute || !weekday) return null;
  return { hour: hour === "24" ? "00" : hour, minute, weekday };
}

const WEEKDAY_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// 认不出的星期返回 null：按周一兜底会让 dayShift 静默错一整天，宁可判定为「不可换算」
function weekdayToIso(weekday: string): number | null {
  const idx = WEEKDAY_ORDER.indexOf(weekday);
  if (idx === -1) return null;
  return idx === 0 ? 7 : idx; // 0=周日..6=周六 → 1..7（周一..周日）
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
// 用「按参考日偏移反解 + 最多两次校正」代替逐分钟扫描：列表里每行都要换算，
// 扫描 1440 次 formatToParts 会让几十行的表格卡住。夏令时切换当天第一轮解出的墙上时间
// 会差一小时，校正一轮即可命中；跳表空档里不存在该时刻，两轮都对不上就返回 null。
export function wallTimeToUtc(hhmm: string, timeZone: string, base: Date = new Date()): { utc: string; dayShift: number } | null {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  const dayStart = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
  const targetMinutes = h * 60 + m;

  const origin = partsInTimeZone(new Date(dayStart), timeZone);
  if (!origin) return null;
  // 参考日 UTC 零点这一刻的本地偏移（分钟），只作为初值。
  // 候选归一到参考日之内（跨日由 dayShift 表达），与原先「在 UTC 日内找匹配」的口径一致：
  // 否则会命中前一天同一墙上时刻，把夏令时跳表空档误判成可换算。
  const originOffset = Number(origin.hour) * 60 + Number(origin.minute);
  const initialOffset = (((targetMinutes - originOffset) % 1440) + 1440) % 1440;
  let candidateMs = dayStart + initialOffset * 60_000;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = partsInTimeZone(new Date(candidateMs), timeZone);
    if (!parts) return null;
    const wallMinutes = Number(parts.hour) * 60 + Number(parts.minute);
    if (wallMinutes === targetMinutes && candidateMs >= dayStart && candidateMs < dayStart + 86_400_000) {
      const tzWeekday = weekdayToIso(parts.weekday);
      // 星期认不出就整次判定为不可换算，不能按周一兜底把 dayShift 算错一整天
      if (tzWeekday === null) return null;
      const utcDate = new Date(candidateMs);
      const utc = `${String(utcDate.getUTCHours()).padStart(2, "0")}:${String(utcDate.getUTCMinutes()).padStart(2, "0")}`;
      // dayShift：匹配时刻的 UTC 星期 − 该时刻在所选时区下的星期（用户选「周一」时，UTC 可能落在周日）。
      const utcDay = utcDate.getUTCDay();
      const matchedUtcWd = utcDay === 0 ? 7 : utcDay;
      const dayShift = ((matchedUtcWd - tzWeekday + 7) % 7);
      const signed = dayShift > 3 ? dayShift - 7 : dayShift;
      return { utc, dayShift: signed };
    }
    // 用最短带符号差校正：直接相减在「跨 0 点」时方向会反（差出 ±1439 分钟）
    const delta = (((targetMinutes - wallMinutes) % 1440) + 2160) % 1440 - 720;
    candidateMs += delta * 60_000;
  }
  return null;
}

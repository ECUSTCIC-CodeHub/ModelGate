const SHANGHAI_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function toShanghaiDatetime(date: Date): string {
  const parts = SHANGHAI_FORMATTER.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")}.${ms}`;
}

export function toShanghaiDatetimeNoMs(date: Date): string {
  return toShanghaiDatetime(date).slice(0, 19);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// 存储/比较统一使用 UTC 裸字符串（无时区后缀），应用层约定按 UTC 解释。
export function toUtcDatetime(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export const toMysqlDatetime = toUtcDatetime;

// 解析存储的 UTC 裸字符串（'YYYY-MM-DD HH:MM:SS'）为绝对时刻；容忍已是 ISO 带后缀的输入。
export function parseStoredUtc(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const withTz = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withTz);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 取 date 在 UTC 下的星期（1..7，周一..周日）与当日已过分钟，供按 UTC 时分判断重复性时段使用。
export function utcWallTime(date: Date = new Date()): { day: number; minutes: number } {
  const jsDay = date.getUTCDay(); // 0=周日..6=周六
  return {
    day: jsDay === 0 ? 7 : jsDay,
    minutes: date.getUTCHours() * 60 + date.getUTCMinutes(),
  };
}

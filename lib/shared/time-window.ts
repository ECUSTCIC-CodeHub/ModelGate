// 时段窗口（星期 + 时分）在「浏览器/所选时区的墙上时间」与「UTC」之间的换算，
// 供渠道「限制时段」与「分时倍率」两个编辑器共用。落库与网关判定统一按 UTC。
//
// 换算必须同时平移时分与星期：本地 00:00-08:00 在东八区落在前一天的 UTC 16:00-24:00，
// 只平移时分会让「凌晨段归属前一日」落到错误的星期上。
//
// 档位是每周循环的，换算以参考日（默认当前时刻）解出偏移，夏令时切换前后同一档位仍会差 1 小时；
// 落在夏令时跳表空档里的时刻无法换算，调用方据此阻断保存，不能把墙上时间当 UTC 落库。

import { utcTimeToWall, wallTimeToUtc } from "@/lib/shared/timezone";

export type WallClockWindow = {
  days: number[];
  start: string;
  end: string;
};

export type WindowConversionResult = {
  // 转换后的窗口；换算不可行的行保留原值
  windows: WallClockWindow[];
  // 换算不可行的行下标（保留原值），调用方据此提示并阻断保存
  failed: number[];
};

const DAYS_PER_WEEK = 7;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function shiftDays(days: number[], deltaDays: number): number[] {
  const delta = ((deltaDays % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  return [...new Set(days.map((day) => ((day - 1 + delta) % DAYS_PER_WEEK) + 1))].sort((a, b) => a - b);
}

// 还没填完的行（未选星期、时分留空）：不落库，也不算错误
export function isIncompleteWindow(window: WallClockWindow): boolean {
  return window.days.length === 0 || !window.start || !window.end;
}

// 能参与换算的行：星期非空、时分格式合法、首尾不同
export function isConvertibleWindow(window: WallClockWindow): boolean {
  return window.days.length > 0
    && window.start !== window.end
    && TIME_RE.test(window.start)
    && TIME_RE.test(window.end);
}

// 判断某一时刻（UTC 星期 1..7 与当日分钟 0..1439）是否落在窗口内。
// 命中判定为闭区间 [start, end]；跨零点窗口的凌晨段归属**前一日**的 days，
// 与「22:00-06:00 勾周一 = 周一 22:00 至周二 06:00」的自然理解一致。
// 渠道可用时段与分时倍率共用这一份判定，避免两处口径漂移。
export function matchesWindow(window: WallClockWindow, day: number, minutes: number): boolean {
  const [sh, sm] = window.start.split(":").map(Number);
  const [eh, em] = window.end.split(":").map(Number);
  if (!Number.isInteger(sh) || !Number.isInteger(sm) || !Number.isInteger(eh) || !Number.isInteger(em)) return false;
  const startM = sh * 60 + sm;
  const endM = eh * 60 + em;
  if (endM > startM) {
    return window.days.includes(day) && minutes >= startM && minutes <= endM;
  }
  const prevDay = day === 1 ? DAYS_PER_WEEK : day - 1;
  return (window.days.includes(day) && minutes >= startM)
    || (window.days.includes(prevDay) && minutes <= endM);
}

// 墙上时间 => UTC：星期按起点的跨日偏移平移。
// 终点与起点各自解析：跨夏令时切换的档位两端按真实偏移换算，长度随之变化（与真实时长一致）。
export function windowToUtc(
  window: WallClockWindow,
  timeZone: string,
  base: Date = new Date(),
): WallClockWindow | null {
  const start = wallTimeToUtc(window.start, timeZone, base);
  const end = wallTimeToUtc(window.end, timeZone, base);
  if (!start || !end) return null;
  return { days: shiftDays(window.days, start.dayShift), start: start.utc, end: end.utc };
}

// UTC => 墙上时间：星期按起点跨日的方向反向平移，与 windowToUtc 互逆。
export function windowToWall(
  window: WallClockWindow,
  timeZone: string,
  base: Date = new Date(),
): WallClockWindow | null {
  const start = utcTimeToWall(window.start, timeZone, base);
  const end = utcTimeToWall(window.end, timeZone, base);
  if (!start || !end) return null;
  // 拿不到跨日偏移就不能只搬时分：星期会差一天，宁可判定为不可换算
  const shifted = wallTimeToUtc(start, timeZone, base);
  if (!shifted) return null;
  return { days: shiftDays(window.days, -shifted.dayShift), start, end };
}

// 编辑器行 => 落库 JSON：窗格里的时分按所选时区换算成 UTC。
// 换算不可行的行保留原值并记下下标，由调用方提示并阻断保存。
export function serializeTimeWindows(
  windows: WallClockWindow[],
  timeZone: string,
  base: Date = new Date(),
): { json: string; failed: number[] } {
  const failed: number[] = [];
  const out: WallClockWindow[] = [];
  windows.forEach((window, index) => {
    if (isIncompleteWindow(window)) return;
    if (!isConvertibleWindow(window)) {
      failed.push(index);
      out.push({ days: [...window.days], start: window.start, end: window.end });
      return;
    }
    const converted = windowToUtc(window, timeZone, base);
    if (!converted) {
      failed.push(index);
      out.push({ days: [...window.days], start: window.start, end: window.end });
      return;
    }
    out.push(converted);
  });
  return { json: JSON.stringify(out), failed };
}

// 落库 JSON => 编辑器行：UTC 时分按所选时区换算成墙上时间。
// 脏数据逐项丢弃；换算不可行的行保留原值并记下下标。
export function parseTimeWindows(
  raw: string | null | undefined,
  timeZone: string,
  base: Date = new Date(),
): WindowConversionResult {
  if (!raw) return { windows: [], failed: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { windows: [], failed: [] };
  }
  if (!Array.isArray(parsed)) return { windows: [], failed: [] };

  const windows: WallClockWindow[] = [];
  const failed: number[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const days = Array.isArray(record.days)
      ? [...new Set(
        record.days
          .map((day) => Number(day))
          .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7),
      )].sort((a, b) => a - b)
      : [];
    const start = typeof record.start === "string" ? record.start : "";
    const end = typeof record.end === "string" ? record.end : "";
    const window = { days, start, end };
    const index = windows.length;
    if (isIncompleteWindow(window) || !isConvertibleWindow(window)) {
      windows.push(window);
      continue;
    }
    const converted = windowToWall(window, timeZone, base);
    if (!converted) {
      failed.push(index);
      windows.push(window);
      continue;
    }
    windows.push(converted);
  }
  return { windows, failed };
}

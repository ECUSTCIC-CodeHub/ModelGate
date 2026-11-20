// 分时档在库里按 UTC 存储与判定（见 lib/gateway/multiplier-schedule.ts），
// 管理端编辑器按设置者浏览器时区展示与填写：载入时 UTC => 墙上时间，提交时墙上时间 => UTC，
// 与「过期时间」、渠道「限制时段」同一套口径。
//
// 换算复用 lib/shared/timezone.ts（Intl 实现，跟随夏令时），这里只补分时档特有的两件事：
// 1. 星期随跨日整体平移——本地 00:00-08:00 在东八区落在前一天的 UTC 16:00-24:00，
//    只平移时分会让「凌晨段归属前一日」落到错误的星期上；
// 2. 草稿与落库载荷之间的字段映射。
//
// 档位是每周循环的，换算以参考日（默认当前时刻）解出偏移，夏令时切换前后同一档位仍会差 1 小时，
// 与渠道「限制时段」的既有局限一致；落在夏令时跳表空档里的时刻无法换算，提交时直接报错而不是静默落库。

import { browserTimeZone, utcTimeToWall, wallTimeToUtc } from "@/lib/shared/timezone";
import { isScheduleDraftDiscarded, type ScheduleDraftWindow } from "@/lib/shared/multiplier-shadow";

export type ScheduleWindow = {
  days: number[];
  start: string;
  end: string;
};

export type MultiplierSchedulePayload = ScheduleWindow & {
  token_multiplier: number | null;
  request_multiplier: number | null;
};

export type MultiplierScheduleDraft = ScheduleDraftWindow & { key: string };

const DAYS_PER_WEEK = 7;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function shiftDays(days: number[], deltaDays: number): number[] {
  const delta = ((deltaDays % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  return [...new Set(days.map((day) => ((day - 1 + delta) % DAYS_PER_WEEK) + 1))].sort((a, b) => a - b);
}

function copyWindow(window: ScheduleWindow): ScheduleWindow {
  return { days: [...window.days], start: window.start, end: window.end };
}

// 编辑中还没填完的档位（未选星期、首尾相同）：换算它没有意义，
// 提交时已被 isScheduleDraftDiscarded 或服务端校验挡掉
function isUnfinished(window: ScheduleWindow): boolean {
  return window.days.length === 0 || window.start === window.end;
}

// 需要真正换算的档位：时分格式合法、首尾不同、有星期。不满足的原样带给服务端校验
function isConvertible(window: ScheduleWindow): boolean {
  return window.days.length > 0
    && window.start !== window.end
    && TIME_RE.test(window.start)
    && TIME_RE.test(window.end);
}

// UTC 时分 => 指定时区的墙上时分，星期按起点跨日的方向反向平移。
// 起点换回 UTC 时的 dayShift 与正向换算同源，保证两个方向互逆；换算不可行时返回 null。
export function tryScheduleToLocal(
  window: ScheduleWindow,
  timeZone: string,
  base: Date = new Date(),
): ScheduleWindow | null {
  const start = utcTimeToWall(window.start, timeZone, base);
  const end = utcTimeToWall(window.end, timeZone, base);
  if (!start || !end) return null;
  // 拿不到跨日偏移就不能只搬时分：星期会差一天，宁可判定为不可换算
  const shifted = wallTimeToUtc(start, timeZone, base);
  if (!shifted) return null;
  return { days: shiftDays(window.days, -shifted.dayShift), start, end };
}

// 指定时区的墙上时分 => UTC 时分，星期按起点的跨日偏移平移。
// 终点与起点各自解析：跨夏令时切换的档位两端按真实偏移换算，长度随之变化（与真实时长一致）。
// 墙上时间落在夏令时跳表空档里时无法换算，返回 null 由调用方决定是否阻断。
export function tryScheduleToUtc(
  window: ScheduleWindow,
  timeZone: string,
  base: Date = new Date(),
): ScheduleWindow | null {
  const start = wallTimeToUtc(window.start, timeZone, base);
  const end = wallTimeToUtc(window.end, timeZone, base);
  if (!start || !end) return null;
  return { days: shiftDays(window.days, start.dayShift), start: start.utc, end: end.utc };
}

// 展示用：换算不可行时原样返回，避免把界面上的时间改坏（提交路径不走这里）
export function scheduleToLocal(window: ScheduleWindow, timeZone: string, base: Date = new Date()): ScheduleWindow {
  if (isUnfinished(window)) return copyWindow(window);
  return tryScheduleToLocal(window, timeZone, base) ?? copyWindow(window);
}

export function scheduleToUtc(window: ScheduleWindow, timeZone: string, base: Date = new Date()): ScheduleWindow {
  if (isUnfinished(window)) return copyWindow(window);
  return tryScheduleToUtc(window, timeZone, base) ?? copyWindow(window);
}

function parseDimension(value: string, index: number, label: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) throw new Error(`第 ${index + 1} 档的${label}倍率不是有效数字。`);
  return num;
}

// 时区默认取设置者浏览器时区；显式传入只用于验证脚本与跨时区场景。
// 换算不可行时抛错：静默把墙上时间当 UTC 落库，会让整档时段偏移数小时且无人察觉。
export function scheduleDraftsToPayload(
  drafts: MultiplierScheduleDraft[],
  timeZone: string = browserTimeZone(),
  base: Date = new Date(),
): MultiplierSchedulePayload[] {
  const out: MultiplierSchedulePayload[] = [];
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    // 与提交前的丢弃口径共用一份判定，避免「编辑器说不会生效、保存后其实还在」
    if (isScheduleDraftDiscarded(draft)) continue;
    const tokenMultiplier = parseDimension(draft.token_multiplier, index, "Token");
    const requestMultiplier = parseDimension(draft.request_multiplier, index, "请求");
    let window: ScheduleWindow = { days: draft.days, start: draft.start, end: draft.end };
    if (isConvertible(window)) {
      const converted = tryScheduleToUtc(window, timeZone, base);
      if (!converted) {
        throw new Error(`第 ${index + 1} 档的时段在时区 ${timeZone} 下无法换算（时区不可用，或时段正好落在夏令时跳过的空档里），请调整时间。`);
      }
      window = converted;
    }
    out.push({
      days: window.days,
      start: window.start,
      end: window.end,
      token_multiplier: tokenMultiplier,
      request_multiplier: requestMultiplier,
    });
  }
  return out;
}

export function schedulesToDrafts(
  schedules: MultiplierSchedulePayload[],
  timeZone: string = browserTimeZone(),
  base: Date = new Date(),
): MultiplierScheduleDraft[] {
  return schedules.map((schedule, index) => {
    const window = scheduleToLocal(schedule, timeZone, base);
    return {
      key: `s${index}`,
      days: window.days,
      start: window.start,
      end: window.end,
      token_multiplier: schedule.token_multiplier === null ? "" : String(schedule.token_multiplier),
      request_multiplier: schedule.request_multiplier === null ? "" : String(schedule.request_multiplier),
    };
  });
}

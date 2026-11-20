// 分时档在库里按 UTC 存储与判定（见 lib/gateway/multiplier-schedule.ts），
// 管理端编辑器按设置者浏览器时区展示与填写：载入时 UTC => 墙上时间，提交时墙上时间 => UTC，
// 与「过期时间」、渠道「限制时段」同一套口径。
//
// 换算复用 lib/shared/timezone.ts（Intl 实现，跟随夏令时），这里只补分时档特有的两件事：
// 1. 星期随跨日整体平移——本地 00:00-08:00 在东八区落在前一天的 UTC 16:00-24:00，
//    只平移时分会让「凌晨段归属前一日」落到错误的星期上；
// 2. 草稿与落库载荷之间的字段映射。
//
// 档位是每周循环的，换算以当前时刻为参考解出偏移，夏令时切换前后同一档位仍会差 1 小时，
// 与渠道「限制时段」的既有局限一致。

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

function shiftDays(days: number[], deltaDays: number): number[] {
  const delta = ((deltaDays % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  return [...new Set(days.map((day) => ((day - 1 + delta) % DAYS_PER_WEEK) + 1))].sort((a, b) => a - b);
}

function copyWindow(window: ScheduleWindow): ScheduleWindow {
  return { days: [...window.days], start: window.start, end: window.end };
}

// 编辑中还没填完的档位（未选星期、首尾相同）原样返回：换算它没有意义，
// 提交时也已被 isScheduleDraftDiscarded 或服务端校验挡掉
function isUnfinished(window: ScheduleWindow): boolean {
  return window.days.length === 0 || window.start === window.end;
}

// UTC 时分 => 指定时区的墙上时分，星期按起点跨日的方向反向平移。
// 起点换回 UTC 时的 dayShift 与正向换算同源，保证两个方向互逆。
export function scheduleToLocal(window: ScheduleWindow, timeZone: string): ScheduleWindow {
  if (isUnfinished(window)) return copyWindow(window);
  const start = utcTimeToWall(window.start, timeZone);
  const end = utcTimeToWall(window.end, timeZone);
  // 墙上时间非法或落在夏令时缺口里时原样返回，交给服务端校验，不做猜测性平移
  if (!start || !end) return copyWindow(window);
  const dayShift = wallTimeToUtc(start, timeZone)?.dayShift ?? 0;
  return { days: shiftDays(window.days, -dayShift), start, end };
}

// 指定时区的墙上时分 => UTC 时分，星期按起点的跨日偏移平移。
// 终点与起点各自解析：跨夏令时切换的档位两端按真实偏移换算，长度会随之变化（与真实时长一致）。
export function scheduleToUtc(window: ScheduleWindow, timeZone: string): ScheduleWindow {
  if (isUnfinished(window)) return copyWindow(window);
  const start = wallTimeToUtc(window.start, timeZone);
  const end = wallTimeToUtc(window.end, timeZone);
  if (!start || !end) return copyWindow(window);
  return { days: shiftDays(window.days, start.dayShift), start: start.utc, end: end.utc };
}

// 时区默认取设置者浏览器时区；显式传入只用于验证脚本与跨时区场景。
export function scheduleDraftsToPayload(
  drafts: MultiplierScheduleDraft[],
  timeZone: string = browserTimeZone(),
): MultiplierSchedulePayload[] {
  const out: MultiplierSchedulePayload[] = [];
  for (const draft of drafts) {
    // 与提交前的丢弃口径共用一份判定，避免「编辑器说不会生效、保存后其实还在」
    if (isScheduleDraftDiscarded(draft)) continue;
    const window = scheduleToUtc(draft, timeZone);
    out.push({
      days: window.days,
      start: window.start,
      end: window.end,
      token_multiplier: draft.token_multiplier.trim() === "" ? null : Number(draft.token_multiplier),
      request_multiplier: draft.request_multiplier.trim() === "" ? null : Number(draft.request_multiplier),
    });
  }
  return out;
}

export function schedulesToDrafts(
  schedules: MultiplierSchedulePayload[],
  timeZone: string = browserTimeZone(),
): MultiplierScheduleDraft[] {
  return schedules.map((schedule, index) => {
    const window = scheduleToLocal(schedule, timeZone);
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

// 分时倍率在库里按 UTC 存储与判定（见 lib/gateway/multiplier-schedule.ts），
// 管理端编辑器按设置者浏览器时区展示与填写：载入时 UTC => 墙上时间，提交时墙上时间 => UTC，
// 与「过期时间」、渠道「限制时段」同一套口径。
//
// 墙上时间换算是两个编辑器共用的（lib/shared/time-window.ts，含星期随跨日平移），
// 这里只负责分时档草稿与落库载荷之间的字段映射。

import { browserTimeZone } from "@/lib/shared/timezone";
import { isConvertibleWindow, windowToUtc, windowToWall, type WallClockWindow } from "@/lib/shared/time-window";
import { isScheduleDraftDiscarded, type ScheduleDraftWindow } from "@/lib/shared/multiplier-shadow";

export type ScheduleWindow = WallClockWindow;

export type MultiplierSchedulePayload = WallClockWindow & {
  token_multiplier: number | null;
  request_multiplier: number | null;
};

export type MultiplierScheduleDraft = ScheduleDraftWindow & { key: string };

function copyWindow(window: WallClockWindow): WallClockWindow {
  return { days: [...window.days], start: window.start, end: window.end };
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
    let window: WallClockWindow = { days: draft.days, start: draft.start, end: draft.end };
    if (isConvertibleWindow(window)) {
      const converted = windowToUtc(window, timeZone, base);
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
    // 展示侧换算不可行时原样回填，避免把界面上的时间改坏（提交侧会重新换算并阻断）
    const window = windowToWall(schedule, timeZone, base) ?? copyWindow(schedule);
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

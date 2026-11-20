// 分时档的可读文案：库里按 UTC 存、按 UTC 判定，展示时换成浏览者时区的墙上时间，
// 与编辑器输入口径一致（见 lib/shared/multiplier-schedule-tz.ts）。
// 纯函数，前后端都能用；只负责「怎么说」，不参与判定。

import { browserTimeZone } from "@/lib/shared/timezone";
import { windowToWall, type WallClockWindow } from "@/lib/shared/time-window";

export type ScheduleTextItem = WallClockWindow & {
  token_multiplier: number | null;
  request_multiplier: number | null;
};

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
// 标签上最多列两档，再多就写「等 N 档」，避免把表格撑变形
const MAX_TAG_WINDOWS = 2;

function weekdayLabel(day: number): string {
  return WEEKDAY_LABELS[(((day - 1) % WEEKDAY_LABELS.length) + WEEKDAY_LABELS.length) % WEEKDAY_LABELS.length];
}

// 星期文案：连续段合并成「周一至周五」，含跨周（周日至周二）时首尾接上；
// 全选写「每天」，未选写「未选星期」，与编辑器里的按钮保持一致的说法。
export function formatScheduleDays(days: number[]): string {
  const sorted = [...new Set(days)]
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return "未选星期";
  if (sorted.length === 7) return "每天";

  const runs: Array<[number, number]> = [];
  for (const day of sorted) {
    const last = runs[runs.length - 1];
    if (last && day === last[1] + 1) last[1] = day;
    else runs.push([day, day]);
  }
  // 同时勾了周一与周日时首尾是连着的，合并成一段跨周区间：
  // 起点取尾部那段的起点（周日），终点取首段的终点 + 7（下周），取模后正确回绕成「周日至周X」
  if (runs.length > 1 && runs[0][0] === 1 && runs[runs.length - 1][1] === 7) {
    const tail = runs.pop();
    if (tail) runs[0] = [tail[0], runs[0][1] + 7];
  }
  return runs
    .map(([start, end]) => (start === end ? weekdayLabel(start) : `${weekdayLabel(start)}至${weekdayLabel(end)}`))
    .join("、");
}

// 时段文案：end <= start 表示跨零点，写成「22:00–次日 06:00」避免被读成空档
export function formatScheduleTime(start: string, end: string): string {
  return end <= start ? `${start}–次日 ${end}` : `${start}–${end}`;
}

// 一档里只填了某个维度时只说那个维度，留空表示该维度沿用下层倍率
export function formatScheduleMultipliers(item: ScheduleTextItem): string {
  const parts: string[] = [];
  if (item.token_multiplier !== null) parts.push(`Token ${item.token_multiplier}x`);
  if (item.request_multiplier !== null) parts.push(`请求 ${item.request_multiplier}x`);
  return parts.length > 0 ? parts.join(" / ") : "沿用下级倍率";
}

export type ScheduleTagInput = {
  modelSchedules?: ScheduleTextItem[];
  channelSchedules?: ScheduleTextItem[];
};

type DimensionKey = "token_multiplier" | "request_multiplier";

// 该维度取哪一层的档位：模型层配了就用模型层（模型级优先），否则用渠道层。
// 只看「配了什么」，不看此刻是否命中——标签内容不能随时刻漂移
function pickLayerWindows(
  dimension: DimensionKey,
  modelSchedules: ScheduleTextItem[],
  channelSchedules: ScheduleTextItem[],
): ScheduleTextItem[] {
  const configured = (list: ScheduleTextItem[]) => list.filter((item) => item[dimension] !== null);
  const modelWindows = configured(modelSchedules);
  return modelWindows.length > 0 ? modelWindows : configured(channelSchedules);
}

function summarizeDimension(
  label: string,
  dimension: DimensionKey,
  windows: ScheduleTextItem[],
  timeZone: string,
): string | null {
  if (windows.length === 0) return null;
  const listed = windows.slice(0, MAX_TAG_WINDOWS).map((item) => {
    const wall = windowToWall(item, timeZone);
    // 首尾相同是非法配置（网关不命中），别按跨零点写成「全天」
    if (item.start === item.end) return `${item[dimension]}x 时段配置无效`;
    const text = wall ?? item;
    // 全周生效就不写星期，省下的宽度留给时段
    const days = text.days.length === 7 ? "" : `${formatScheduleDays(text.days)} `;
    return `${item[dimension]}x ${days}${formatScheduleTime(text.start, text.end)}`;
  });
  const more = windows.length > listed.length ? ` 等${windows.length}档` : "";
  return `${label} ${listed.join("、")}${more}`;
}

// 标签文案：`T 0.5x 00:00–08:00 · R 2x 22:00–次日 06:00`
// 只描述「配了什么」，与此刻是否命中无关——配了分时的模型始终要能看出来。
export function summarizeScheduleTag(input: ScheduleTagInput, timeZone: string = browserTimeZone()): string | null {
  const modelSchedules = input.modelSchedules ?? [];
  const channelSchedules = input.channelSchedules ?? [];
  const parts = [
    summarizeDimension(
      "T",
      "token_multiplier",
      pickLayerWindows("token_multiplier", modelSchedules, channelSchedules),
      timeZone,
    ),
    summarizeDimension(
      "R",
      "request_multiplier",
      pickLayerWindows("request_multiplier", modelSchedules, channelSchedules),
      timeZone,
    ),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// 一个别名挂多条渠道时：各渠道档位常常完全相同，去重后最多留两段，避免标签过长
export function summarizeChannelScheduleTags(
  inputs: ScheduleTagInput[],
  timeZone: string = browserTimeZone(),
): string | null {
  const seen: string[] = [];
  for (const input of inputs) {
    const tag = summarizeScheduleTag(input, timeZone);
    if (tag && !seen.includes(tag)) seen.push(tag);
  }
  if (seen.length === 0) return null;
  const listed = seen.slice(0, MAX_TAG_WINDOWS);
  const more = seen.length > listed.length ? ` 等${seen.length}种` : "";
  // 多渠道之间用分号，避免与维度之间的「·」混在一起
  return `${listed.join("；")}${more}`;
}

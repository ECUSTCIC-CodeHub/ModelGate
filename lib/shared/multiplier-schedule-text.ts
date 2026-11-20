// 分时档的可读文案：库里按 UTC 存、按 UTC 判定，展示时换成浏览者时区的墙上时间，
// 与编辑器输入口径一致（见 lib/shared/multiplier-schedule-tz.ts）。
// 纯函数，前后端都能用；只负责「怎么说」，不参与判定。

import { browserTimeZone } from "@/lib/shared/timezone";
import { windowToWall, type WallClockWindow } from "@/lib/shared/time-window";

export type ScheduleTextItem = WallClockWindow & {
  token_multiplier: number | null;
  request_multiplier: number | null;
};

// 档位清单最多列这么多行，悬浮一般也放得下，再多就折叠成「还有 N 档」
const MAX_LISTED_WINDOWS = 8;

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

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

// 单档文案：`周五 00:00–08:00 · Token 0.5x`，时间按浏览者时区换算
function describeWindow(item: ScheduleTextItem, timeZone: string): string {
  // 首尾相同是非法配置（网关不命中），别按跨零点写成「全天」
  if (item.start === item.end) return `${formatScheduleMultipliers(item)} · 时段配置无效`;
  const wall = windowToWall(item, timeZone);
  const text = wall ?? item;
  const place = wall ? "" : "（UTC，当前时区无法换算）";
  return `${formatScheduleDays(text.days)} ${formatScheduleTime(text.start, text.end)} · ${formatScheduleMultipliers(item)}${place}`;
}

export type ScheduleTagInput = {
  modelSchedules?: ScheduleTextItem[];
  channelSchedules?: ScheduleTextItem[];
};

type DimensionKey = "token_multiplier" | "request_multiplier";

// 「分时」标签只做标记，具体时段与倍率放悬浮：标签本身不应该撑开表格列。
// 只要配了任一维度的档位就有标签，与此刻是否命中无关。
export function hasSchedule(input: ScheduleTagInput): boolean {
  const modelSchedules = input.modelSchedules ?? [];
  const channelSchedules = input.channelSchedules ?? [];
  return modelSchedules.length > 0 || channelSchedules.length > 0;
}

// 逐档清单（不含时区说明，便于多处拼装后再统一追加一次）
function scheduleLayers(input: ScheduleTagInput, timeZone: string): string[] {
  const lines: string[] = [];
  const appendLayer = (heading: string, list: ScheduleTextItem[]) => {
    if (list.length === 0) return;
    lines.push(`${heading}：`);
    for (const item of list.slice(0, MAX_LISTED_WINDOWS)) lines.push(`· ${describeWindow(item, timeZone)}`);
    // 截断按层计，文案要写清是哪一层还剩几档
    if (list.length > MAX_LISTED_WINDOWS) lines.push(`· …${heading}还有 ${list.length - MAX_LISTED_WINDOWS} 档`);
  };
  appendLayer("模型级", input.modelSchedules ?? []);
  appendLayer("渠道级", input.channelSchedules ?? []);
  return lines;
}

function timeZoneHint(timeZone: string): string {
  return `时间按你的浏览器时区（${timeZone}）显示；模型级优先，同层多档命中取最上面一档。`;
}

// 悬浮内容：逐档列出时段与倍率，并说明时间口径与优先级
export function describeScheduleDetail(
  input: ScheduleTagInput,
  timeZone: string = browserTimeZone(),
): string {
  const layers = scheduleLayers(input, timeZone);
  if (layers.length === 0) return "";
  return [...layers, timeZoneHint(timeZone)].join("\n");
}

// 一个别名挂多条渠道时：档位完全相同的渠道归成一段，段首标出是哪些渠道，
// 时区与优先级说明只追加一次；档位不同的渠道各自成段，不会互相串台
export function describeChannelScheduleDetail(
  entries: Array<{ input: ScheduleTagInput; channelName?: string }>,
  timeZone: string = browserTimeZone(),
): string {
  const groups = new Map<string, { block: string; names: string[] }>();
  for (const { input, channelName } of entries) {
    const layers = scheduleLayers(input, timeZone);
    if (layers.length === 0) continue;
    const block = layers.join("\n");
    const group = groups.get(block) ?? { block, names: [] };
    if (channelName) group.names.push(channelName);
    groups.set(block, group);
  }
  if (groups.size === 0) return "";

  const blocks = [...groups.values()].map(({ block, names }) =>
    names.length > 0 ? `${names.join("、")}：\n${block}` : block,
  );
  return [...blocks, timeZoneHint(timeZone)].join("\n\n");
}

// 某个维度是否配了档位：只用来决定「分时」标记出不出，按维度判避免请求列跟着 Token 一起标
export function hasDimensionSchedule(input: ScheduleTagInput, dimension: "token" | "request"): boolean {
  const key: DimensionKey = dimension === "token" ? "token_multiplier" : "request_multiplier";
  return [...(input.modelSchedules ?? []), ...(input.channelSchedules ?? [])].some((item) => item[key] !== null);
}

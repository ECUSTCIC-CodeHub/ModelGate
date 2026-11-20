// 分时档的可读文案：库里按 UTC 存、按 UTC 判定，展示时换成浏览者时区的墙上时间，
// 与编辑器输入口径一致（见 lib/shared/multiplier-schedule-tz.ts）。
// 纯函数，前后端都能用；只负责「怎么说」，不参与判定。

import { browserTimeZone } from "@/lib/shared/timezone";
import { matchesWindow, windowToWall, type WallClockWindow } from "@/lib/shared/time-window";

export type ScheduleTextItem = WallClockWindow & {
  token_multiplier: number | null;
  request_multiplier: number | null;
};

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

// 一层档位整理成若干行，时间按 timeZone 换算；activeIndex 那一行标注「此刻命中」。
// 换算不可行（时区数据异常）时退回 UTC 原值并注明，避免展示出错位的时间。
export function describeScheduleWindows(
  schedules: ScheduleTextItem[],
  timeZone: string = browserTimeZone(),
  activeIndex: number | null = null,
): string[] {
  return schedules.map((item, index) => {
    const wall = windowToWall(item, timeZone);
    const text = wall ?? item;
    const place = wall ? "" : "（UTC，当前时区无法换算）";
    // 只说「命中」不说「生效」：两层可能同时命中，谁生效还要看层优先级，
    // 标成「生效」会让被覆盖那层也写着同一个词，和页面上的数值打架
    const active = activeIndex === index ? "（此刻命中）" : "";
    return `${formatScheduleDays(text.days)} ${formatScheduleTime(text.start, text.end)} · ${formatScheduleMultipliers(item)}${place}${active}`;
  });
}

// 单层最多列这么多档，再多就折叠成「还有 N 档」，避免 tooltip 长到看不完
const MAX_LISTED_WINDOWS = 6;
// 用户侧按渠道分组时可能更啰嗦，整体再设一个上限
const MAX_TOOLTIP_LINES = 12;

// 此刻命中的档位下标：与网关同一份 matchesWindow 判定，只是这里按 UTC 取当前的星期与分钟，
// 不引 gateway 层，保持 shared 只依赖 shared。
function activeScheduleIndex(schedules: ScheduleTextItem[], now: Date): number | null {
  const utcDay = now.getUTCDay();
  const day = utcDay === 0 ? 7 : utcDay;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (let index = 0; index < schedules.length; index += 1) {
    if (matchesWindow(schedules[index], day, minutes)) return index;
  }
  return null;
}

function appendLayer(lines: string[], heading: string, list: ScheduleTextItem[], timeZone: string, now: Date) {
  if (list.length === 0) return;
  lines.push(`${heading}：`);
  const listed = list.slice(0, MAX_LISTED_WINDOWS);
  const activeIndex = activeScheduleIndex(list, now);
  for (const line of describeScheduleWindows(listed, timeZone, activeIndex)) lines.push(`· ${line}`);
  if (list.length > listed.length) lines.push(`· …还有 ${list.length - listed.length} 档`);
  // 命中的那档被折叠掉时单独补一行，否则用户看不到「现在是哪档」
  if (activeIndex !== null && activeIndex >= listed.length) {
    const activeLine = describeScheduleWindows([list[activeIndex]], timeZone, 0)[0];
    lines.push(`· 此刻命中：${activeLine}`);
  }
}

// 渠道页的列表行与卡片共用同一段悬浮说明：现在多少钱、哪个档位在生效、每档具体是什么时候。
export function describeScheduleTooltip(params: {
  baseToken: number;
  baseRequest: number;
  effectiveToken: number;
  effectiveRequest: number;
  scheduleApplied: boolean;
  // describeScheduleSource 的结论，调用点已经算好，这里只负责拼句子
  source?: string;
  modelSchedules?: ScheduleTextItem[];
  channelSchedules?: ScheduleTextItem[];
  timeZone?: string;
  now?: Date;
}): string {
  const timeZone = params.timeZone ?? browserTimeZone();
  const now = params.now ?? new Date();
  const lines: string[] = [];
  lines.push(
    params.scheduleApplied
      ? `当前时段生效 Token ${params.effectiveToken}x / 请求 ${params.effectiveRequest}x${params.source ? `；${params.source}` : ""}。`
      : "当前时段未命中任何分时档，生效倍率等于基础倍率。",
  );
  lines.push(`基础倍率 Token ${params.baseToken}x / 请求 ${params.baseRequest}x。`);

  const modelSchedules = params.modelSchedules ?? [];
  const channelSchedules = params.channelSchedules ?? [];
  if (modelSchedules.length === 0 && channelSchedules.length === 0) return lines.join("\n");

  lines.push("");
  lines.push(`分时档（时间按浏览器时区 ${timeZone} 显示；模型级优先，同层多档命中取最上面一档）`);
  appendLayer(lines, "模型级", modelSchedules, timeZone, now);
  appendLayer(lines, "渠道级", channelSchedules, timeZone, now);
  return lines.join("\n");
}

export type ChannelScheduleInput = {
  channelName?: string;
  modelSchedules?: ScheduleTextItem[];
  channelSchedules?: ScheduleTextItem[];
};

// 用户侧（模型列表、首页配额卡）的单层清单：带「模型档 / 渠道档」前缀，同样只换算前 6 档
function appendPrefixed(lines: string[], prefix: string, list: ScheduleTextItem[], timeZone: string, now: Date) {
  if (list.length === 0) return;
  const listed = list.slice(0, MAX_LISTED_WINDOWS);
  const activeIndex = activeScheduleIndex(list, now);
  // 命中的那档被折叠时先补一行：否则尾部补行会被整体行数上限截掉，
  // 最需要知道「现在哪档」的时候反而看不到
  if (activeIndex !== null && activeIndex >= listed.length) {
    lines.push(`· ${prefix} 此刻命中：${describeScheduleWindows([list[activeIndex]], timeZone, 0)[0]}`);
  }
  for (const line of describeScheduleWindows(listed, timeZone, activeIndex)) lines.push(`· ${prefix} ${line}`);
  if (list.length > listed.length) lines.push(`· ${prefix} 还有 ${list.length - listed.length} 档未列出`);
}

// 用户侧（模型列表、首页配额卡）：一个别名可能挂多条渠道，按渠道分组列出各自的档位，
// 行数过多时截断，并在末尾统一说明时区与优先级口径。
export function describeChannelSchedules(
  inputs: ChannelScheduleInput[],
  timeZone: string = browserTimeZone(),
  now: Date = new Date(),
): string[] {
  const multipleChannels = inputs.length > 1;
  const lines: string[] = [];
  for (const input of inputs) {
    const modelSchedules = input.modelSchedules ?? [];
    const channelSchedules = input.channelSchedules ?? [];
    if (modelSchedules.length === 0 && channelSchedules.length === 0) continue;
    if (multipleChannels && input.channelName) lines.push(`${input.channelName}：`);
    appendPrefixed(lines, "模型档", modelSchedules, timeZone, now);
    appendPrefixed(lines, "渠道档", channelSchedules, timeZone, now);
  }
  if (lines.length === 0) return [];
  const capped = lines.slice(0, MAX_TOOLTIP_LINES);
  if (lines.length > capped.length) capped.push(`· …还有 ${lines.length - capped.length} 行`);
  capped.push(
    `时间按你的浏览器时区（${timeZone}）显示；模型级优先，同层多档命中取最上面一档，未命中任何档位时使用基础倍率。`,
  );
  return capped;
}

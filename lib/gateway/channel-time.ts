import { toUtcDatetime, parseStoredUtc, utcWallTime } from "@/lib/core/db/datetime";
import { matchesWindow } from "@/lib/shared/time-window";

const MAX_WINDOWS = 20;
const TIME_RE = /^\d{1,2}:\d{2}$/;

export type TimeWindow = {
  days: number[]; // 1..7，周一..周日
  start: string; // HH:MM
  end: string; // HH:MM
};

// 写入侧允许单小时位（9:30），编辑器与判定都按两位时分处理：
// 这里统一补零，避免历史数据在编辑器里显示成空框、被当成"未配置"
function normalizeClockTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!TIME_RE.test(trimmed)) return null;
  const [h, m] = trimmed.split(":");
  const hour = Number(h);
  const minute = Number(m);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// 三态：未配置（含空数组）、配置损坏、可用配置。
// 三者不能折叠成「有没有 windows」：空数组是合法的「不限制」，
// 而配了一堆却一条都用不了说明数据坏了，要按拒绝处理并告警。
type RestrictionsState = { kind: "empty" | "broken" | "ok"; windows: TimeWindow[]; dropped: number };

function parseRestrictionsState(raw: string | null | undefined): RestrictionsState {
  if (!raw || raw.trim() === "") return { kind: "empty", windows: [], dropped: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "broken", windows: [], dropped: 0 };
  }
  if (!Array.isArray(parsed)) return { kind: "broken", windows: [], dropped: 0 };
  if (parsed.length === 0) return { kind: "empty", windows: [], dropped: 0 };

  const windows: TimeWindow[] = [];
  let dropped = 0;
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      dropped += 1;
      continue;
    }
    const record = item as Record<string, unknown>;
    const days = Array.isArray(record.days)
      ? record.days
        .map((d) => Number(d))
        .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
      : [];
    const start = normalizeClockTime(record.start);
    const end = normalizeClockTime(record.end);
    // 首尾相同的行永远不命中，等同于没配；丢掉它才能让「整份配置都无效」走到不可用分支
    if (days.length === 0 || !start || !end || start === end) {
      dropped += 1;
      continue;
    }
    windows.push({ days: [...new Set(days)].sort((a, b) => a - b), start, end });
    if (windows.length >= MAX_WINDOWS) break;
  }
  return { kind: windows.length > 0 ? "ok" : "broken", windows, dropped };
}

export function parseTimeRestrictions(raw: string | null | undefined): TimeWindow[] {
  return parseRestrictionsState(raw).windows;
}

const RESTRICTION_LOG_INTERVAL_MS = 60_000;
let lastRestrictionLogAt = 0;

// 路由热路径按分钟级节流：损坏或部分丢弃都要留痕，但每 60s 每个进程最多一条
function logRestrictionProblem(message: string, raw: string | null | undefined) {
  const nowMs = Date.now();
  if (nowMs - lastRestrictionLogAt < RESTRICTION_LOG_INTERVAL_MS) return;
  lastRestrictionLogAt = nowMs;
  const preview = raw ? raw.slice(0, 120) : "";
  console.warn(`[channel-time] ${message}：${preview}`);
}

// 未配置时段则不限制（始终允许）；配置后仅窗口内允许。
// start/end 存储为 UTC 时分，判断也按 UTC 墙上时间，不依赖服务器时区。
// 命中判定与分时倍率共用 lib/shared/time-window.ts 的 matchesWindow：
// 跨零点窗口的凌晨段归属**前一日**的 days（22:00-06:00 勾周一 = 周一 22:00 至周二 06:00），
// 与编辑器里「结束时间早于开始时间表示跨午夜」的表述一致。
export function isChannelTimeAllowed(raw: string | null | undefined, now: Date = new Date()): boolean {
  const state = parseRestrictionsState(raw);
  if (state.kind === "empty") return true;
  // 配了但一条都用不了：无法确认是否该放行，按拒绝处理并告警，
  // 不能落到「不限制」上，否则配置损坏会让渠道静默变成 24/7 可用
  if (state.kind === "broken") {
    logRestrictionProblem("time_restrictions 没有可用时段，按不可用处理", raw);
    return false;
  }
  if (state.dropped > 0) {
    logRestrictionProblem(`time_restrictions 有 ${state.dropped} 个时段非法已忽略`, raw);
  }
  const { day, minutes } = utcWallTime(now);
  return state.windows.some((win) => matchesWindow(win, day, minutes));
}

export function isChannelExpired(expiresAt: string | Date | null | undefined): boolean {
  const date = parseStoredUtc(expiresAt);
  if (!date) return false;
  return date.getTime() <= Date.now();
}

export function toLocalDatetime(date: Date): string {
  return toUtcDatetime(date);
}

export function validateTimeRestrictions(input: unknown): { valid: true; windows: TimeWindow[] } | { valid: false; error: string } {
  if (input === null || input === undefined) return { valid: true, windows: [] };
  if (typeof input === "string") {
    if (input.trim() === "") return { valid: true, windows: [] };
    try {
      const parsed = JSON.parse(input);
      return validateTimeRestrictions(parsed);
    } catch {
      return { valid: false, error: "时段限制不是合法的 JSON。" };
    }
  }
  if (!Array.isArray(input)) return { valid: false, error: "时段限制必须为数组。" };
  if (input.length > MAX_WINDOWS) return { valid: false, error: `时段限制最多 ${MAX_WINDOWS} 个。` };
  const windows: TimeWindow[] = [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (!item || typeof item !== "object") return { valid: false, error: `第 ${i + 1} 个时段格式不正确。` };
    const record = item as Record<string, unknown>;
    if (!Array.isArray(record.days)) return { valid: false, error: `第 ${i + 1} 个时段缺少 days。` };
    const days = record.days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
    if (days.length === 0) return { valid: false, error: `第 ${i + 1} 个时段的 days 必须为 1-7 的星期。` };
    // 先归一化再比较：9:30 与 09:30 是同一个时刻，按字符串比会漏掉「首尾相同」，
    // 落库后又会被判定为不命中，等于把渠道配成永久不可用
    const start = normalizeClockTime(record.start);
    const end = normalizeClockTime(record.end);
    if (!start || !end) return { valid: false, error: `第 ${i + 1} 个时段的 start/end 格式应为 HH:MM。` };
    if (start === end) return { valid: false, error: `第 ${i + 1} 个时段的开始时间不能等于结束时间。` };
    windows.push({ days: [...new Set(days)], start, end });
  }
  return { valid: true, windows };
}

// 将已校验的时段窗口归一化为规范 JSON 字符串；空数组返回 ""，保证落库数据可被路由层稳定解析。
export function normalizeTimeRestrictions(windows: TimeWindow[]): string {
  return windows.length > 0 ? JSON.stringify(windows) : "";
}

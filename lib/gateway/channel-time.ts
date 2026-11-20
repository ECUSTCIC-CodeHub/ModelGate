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
  if (typeof value !== "string" || !TIME_RE.test(value)) return null;
  const [h, m] = value.split(":");
  const hour = Number(h);
  const minute = Number(m);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function parseTimeRestrictions(raw: string | null | undefined): TimeWindow[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const windows: TimeWindow[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (!Array.isArray(record.days)) continue;
    const days = record.days
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
    if (days.length === 0) continue;
    const start = normalizeClockTime(record.start);
    const end = normalizeClockTime(record.end);
    if (!start || !end) continue;
    windows.push({ days: [...new Set(days)], start, end });
    if (windows.length >= MAX_WINDOWS) break;
  }
  return windows;
}

const BROKEN_LOG_INTERVAL_MS = 60_000;
let lastBrokenLogAt = 0;

function logBrokenTimeRestrictions(raw: string | null | undefined) {
  if (!raw || raw.trim() === "") return;
  const nowMs = Date.now();
  if (nowMs - lastBrokenLogAt < BROKEN_LOG_INTERVAL_MS) return;
  lastBrokenLogAt = nowMs;
  console.warn(`[channel-time] time_restrictions 解析不出任何时段，按不限制处理：${raw.slice(0, 120)}`);
}

// 未配置时段则不限制（始终允许）；配置后仅窗口内允许。
// start/end 存储为 UTC 时分，判断也按 UTC 墙上时间，不依赖服务器时区。
// 命中判定与分时倍率共用 lib/shared/time-window.ts 的 matchesWindow：
// 跨零点窗口的凌晨段归属**前一日**的 days（22:00-06:00 勾周一 = 周一 22:00 至周二 06:00），
// 与编辑器里「结束时间早于开始时间表示跨午夜」的表述一致。
export function isChannelTimeAllowed(raw: string | null | undefined, now: Date = new Date()): boolean {
  const windows = parseTimeRestrictions(raw);
  if (windows.length === 0) {
    // 原文非空却解析不出任何时段说明配置已损坏：继续保持"不限制"的历史行为，
    // 但留一条限频告警，避免渠道在无人察觉的情况下变成 24/7 可用
    logBrokenTimeRestrictions(raw);
    return true;
  }
  const { day, minutes } = utcWallTime(now);
  return windows.some((win) => matchesWindow(win, day, minutes));
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
    const start = typeof record.start === "string" ? record.start : "";
    const end = typeof record.end === "string" ? record.end : "";
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) return { valid: false, error: `第 ${i + 1} 个时段的 start/end 格式应为 HH:MM。` };
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    if (sh > 23 || sm > 59 || eh > 23 || em > 59) return { valid: false, error: `第 ${i + 1} 个时段的时间超出范围。` };
    if (start === end) return { valid: false, error: `第 ${i + 1} 个时段的开始时间不能等于结束时间。` };
    windows.push({ days: [...new Set(days)], start, end });
  }
  return { valid: true, windows };
}

// 将已校验的时段窗口归一化为规范 JSON 字符串；空数组返回 ""，保证落库数据可被路由层稳定解析。
export function normalizeTimeRestrictions(windows: TimeWindow[]): string {
  return windows.length > 0 ? JSON.stringify(windows) : "";
}

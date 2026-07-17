const MAX_WINDOWS = 20;
const TIME_RE = /^\d{1,2}:\d{2}$/;

export type TimeWindow = {
  days: number[]; // 1..7，周一..周日
  start: string; // HH:MM
  end: string; // HH:MM
};

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
    const start = typeof record.start === "string" ? record.start : "";
    const end = typeof record.end === "string" ? record.end : "";
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) continue;
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    if (sh > 23 || sm > 59 || eh > 23 || em > 59) continue;
    windows.push({ days: [...new Set(days)], start, end });
    if (windows.length >= MAX_WINDOWS) break;
  }
  return windows;
}

function localIsoDay(now: Date): number {
  const jsDay = now.getDay(); // 0=周日..6=周六
  return jsDay === 0 ? 7 : jsDay;
}

// 未配置时段则不限制（始终允许）；配置后仅窗口内允许。基于服务器本地时区判断。
export function isChannelTimeAllowed(raw: string | null | undefined, now: Date = new Date()): boolean {
  const windows = parseTimeRestrictions(raw);
  if (windows.length === 0) return true;
  const day = localIsoDay(now);
  const cur = now.getHours() * 60 + now.getMinutes();
  for (const win of windows) {
    if (!win.days.includes(day)) continue;
    const [sh, sm] = win.start.split(":").map(Number);
    const [eh, em] = win.end.split(":").map(Number);
    const startM = sh * 60 + sm;
    const endM = eh * 60 + em;
    if (endM > startM) {
      if (cur >= startM && cur <= endM) return true;
    } else {
      if (cur >= startM || cur <= endM) return true;
    }
  }
  return false;
}

export function isChannelExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  const t = new Date(expiresAt.replace(" ", "T")).getTime();
  if (Number.isNaN(t)) return false;
  return t <= Date.now();
}

export function toLocalDatetime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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

// 将任意合法输入归一化为规范 JSON 字符串；空或非法返回 ""，保证落库数据可被路由层稳定解析。
export function normalizeTimeRestrictions(input: string | null | undefined): string {
  const windows = parseTimeRestrictions(input);
  return windows.length > 0 ? JSON.stringify(windows) : "";
}

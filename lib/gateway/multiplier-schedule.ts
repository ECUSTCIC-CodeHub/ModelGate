import { utcWallTime } from "@/lib/core/db/datetime";

const MAX_SCHEDULES = 20;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// 时段倍率：命中 window 时用该档倍率，未命中任何时段时回退基础倍率（覆盖语义，不相乘）。
// 模型与渠道共用同一套结构：模型侧回答「这个模型此刻什么价」，渠道侧回答「这条线此刻什么价」。
export type MultiplierSchedule = {
  days: number[]; // 1..7，周一..周日
  start: string; // HH:MM
  end: string; // HH:MM
  token_multiplier: number | null;
  request_multiplier: number | null;
};

function cleanMultiplier(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 100) return null;
  return num;
}

export function parseMultiplierSchedules(raw: string | null | undefined): MultiplierSchedule[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: MultiplierSchedule[] = [];
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
    if (sh > 23 || sm > 59 || eh > 23 || em > 59 || start === end) continue;
    const tokenMultiplier = cleanMultiplier(record.token_multiplier);
    const requestMultiplier = cleanMultiplier(record.request_multiplier);
    if (tokenMultiplier === null && requestMultiplier === null) continue;
    out.push({
      days: [...new Set(days)],
      start,
      end,
      token_multiplier: tokenMultiplier,
      request_multiplier: requestMultiplier,
    });
    if (out.length >= MAX_SCHEDULES) break;
  }
  return out;
}

export function validateMultiplierSchedules(
  input: unknown,
): { valid: true; schedules: MultiplierSchedule[] } | { valid: false; error: string } {
  if (input === null || input === undefined) return { valid: true, schedules: [] };
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return { valid: true, schedules: [] };
    try {
      return validateMultiplierSchedules(JSON.parse(trimmed));
    } catch {
      return { valid: false, error: "分时倍率不是合法的 JSON。" };
    }
  }
  if (!Array.isArray(input)) return { valid: false, error: "分时倍率必须为数组。" };
  if (input.length > MAX_SCHEDULES) return { valid: false, error: `分时倍率最多 ${MAX_SCHEDULES} 档。` };

  const schedules: MultiplierSchedule[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const item = input[i];
    if (!item || typeof item !== "object") return { valid: false, error: `第 ${i + 1} 档分时倍率格式不正确。` };
    const record = item as Record<string, unknown>;
    if (!Array.isArray(record.days)) return { valid: false, error: `第 ${i + 1} 档分时倍率缺少 days。` };
    const days = record.days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7) as number[];
    if (days.length === 0) return { valid: false, error: `第 ${i + 1} 档分时倍率的 days 必须为 1-7 的星期。` };
    if (days.length !== record.days.length) return { valid: false, error: `第 ${i + 1} 档分时倍率的 days 必须为 1-7 的星期。` };
    const start = typeof record.start === "string" ? record.start : "";
    const end = typeof record.end === "string" ? record.end : "";
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
      return { valid: false, error: `第 ${i + 1} 档分时倍率的 start/end 格式应为 HH:MM。` };
    }
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    if (sh > 23 || sm > 59 || eh > 23 || em > 59) return { valid: false, error: `第 ${i + 1} 档分时倍率的时间超出范围。` };
    if (start === end) return { valid: false, error: `第 ${i + 1} 档分时倍率的开始时间不能等于结束时间。` };

    const tokenMultiplier = record.token_multiplier === undefined ? null : cleanMultiplier(record.token_multiplier);
    const requestMultiplier = record.request_multiplier === undefined ? null : cleanMultiplier(record.request_multiplier);
    // token_multiplier / request_multiplier 允许留空表示「该时段不改这一项」，但不能都为空
    if (record.token_multiplier !== undefined && record.token_multiplier !== null && tokenMultiplier === null) {
      return { valid: false, error: `第 ${i + 1} 档分时倍率的 Token 倍率需为 0 到 100 之间的数值。` };
    }
    if (record.request_multiplier !== undefined && record.request_multiplier !== null && requestMultiplier === null) {
      return { valid: false, error: `第 ${i + 1} 档分时倍率的请求倍率需为 0 到 100 之间的数值。` };
    }
    if (tokenMultiplier === null && requestMultiplier === null) {
      return { valid: false, error: `第 ${i + 1} 档分时倍率需至少填写 Token 或请求倍率。` };
    }

    schedules.push({
      days: [...new Set(days)].sort((a, b) => a - b),
      start,
      end,
      token_multiplier: tokenMultiplier,
      request_multiplier: requestMultiplier,
    });
  }
  return { valid: true, schedules };
}

export function normalizeMultiplierSchedules(schedules: MultiplierSchedule[]): string {
  return schedules.length > 0 ? JSON.stringify(schedules) : "";
}

// 时段判断按 UTC 墙上时间解释，不依赖服务器时区；支持跨零点窗口。
// 命中判定为闭区间 [start, end]（含两端），与渠道时段限制 channel-time 的口径一致。
// 跨零点窗口（end <= start）的凌晨段归属**前一日**：22:00-06:00 勾选周一，
// 则周一 22:00 至周二 06:00 都在窗口内，无需额外勾选周二。
function windowMatches(schedule: Pick<MultiplierSchedule, "days" | "start" | "end">, day: number, minutes: number): boolean {
  const [sh, sm] = schedule.start.split(":").map(Number);
  const [eh, em] = schedule.end.split(":").map(Number);
  const startM = sh * 60 + sm;
  const endM = eh * 60 + em;
  if (endM > startM) {
    return schedule.days.includes(day) && minutes >= startM && minutes <= endM;
  }
  // 跨零点：当天 [start, 24:00] 属于当天，[00:00, end] 属于前一天
  const prevDay = day === 1 ? 7 : day - 1;
  return (schedule.days.includes(day) && minutes >= startM)
    || (schedule.days.includes(prevDay) && minutes <= endM);
}

export type ResolvedMultiplier = {
  token_multiplier: number;
  request_multiplier: number;
  schedule_applied: boolean;
  // 各维度最终值来自 layers 的哪一层（0 为最高优先级层），未命中任何档位时为 null。
  // 维度级而不是层级：模型档只填了 token 时，request 的来源仍是渠道档，展示侧要说清这点。
  token_source: number | null;
  request_source: number | null;
  // 各维度命中的档位在其来源层数组里的下标（来源层见 token_source / request_source）。
  // 这一层只填了 token 时，request 可能来自下层，两个下标不是同一层的下标。
  token_schedule_index: number | null;
  request_schedule_index: number | null;
};

// 取请求时刻第一个命中的档位下标；未配置或都未命中时返回 null。
// 下标而不是对象：同一份档位 JSON 里可以有完全相同的两档，按对象反查会张冠李戴。
export function findEffectiveScheduleIndex(
  schedules: MultiplierSchedule[],
  now: Date = new Date(),
): number | null {
  if (schedules.length === 0) return null;
  const { day, minutes } = utcWallTime(now);
  for (let i = 0; i < schedules.length; i += 1) {
    if (windowMatches(schedules[i], day, minutes)) return i;
  }
  return null;
}

// 取请求时刻第一个命中的档位；未配置或都未命中时返回 null。
export function findEffectiveSchedule(
  schedules: MultiplierSchedule[],
  now: Date = new Date(),
): MultiplierSchedule | null {
  const index = findEffectiveScheduleIndex(schedules, now);
  return index === null ? null : schedules[index];
}

// 按优先级逐层解析请求时刻的倍率：layers 里靠前的层优先，每一层只覆盖自己填了的维度，
// 留空的维度继续沿用下层值（覆盖语义，不相乘）；都没命中时回退基础倍率。
// 模型档与渠道档共用这一份实现，保证「模型侧优先、渠道侧补空维度」的口径不会散落在各处。
// 多个时段同时命中时取该层的**第一档**（配置顺序即优先级），与 UI 上「从上到下优先」的提示一致。
// 实现上从最低优先级的层往上覆盖：每一层只在自己填了的维度上落子，
// 这样先落下（优先级低）的值不会被后落下（优先级高）的层的空维度冲掉。
// 反过来从高往低写会因为「命中但该维度留空」而保留旧值，结果变成靠后的层说了算。
export function resolveLayeredMultiplier(
  baseTokenMultiplier: number,
  baseRequestMultiplier: number,
  layers: MultiplierSchedule[][],
  now: Date = new Date(),
): ResolvedMultiplier {
  let tokenMultiplier = baseTokenMultiplier;
  let requestMultiplier = baseRequestMultiplier;
  let scheduleApplied = false;
  let tokenSource: number | null = null;
  let requestSource: number | null = null;
  let tokenScheduleIndex: number | null = null;
  let requestScheduleIndex: number | null = null;
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const index = findEffectiveScheduleIndex(layers[i], now);
    if (index === null) continue;
    const hit = layers[i][index];
    scheduleApplied = true;
    if (hit.token_multiplier !== null) {
      tokenMultiplier = hit.token_multiplier;
      tokenSource = i;
      tokenScheduleIndex = index;
    }
    if (hit.request_multiplier !== null) {
      requestMultiplier = hit.request_multiplier;
      requestSource = i;
      requestScheduleIndex = index;
    }
  }
  return {
    token_multiplier: tokenMultiplier,
    request_multiplier: requestMultiplier,
    schedule_applied: scheduleApplied,
    token_source: tokenSource,
    request_source: requestSource,
    token_schedule_index: tokenScheduleIndex,
    request_schedule_index: requestScheduleIndex,
  };
}

// 分时档「永远不会生效」的判定：网关每层只在第一条命中的档位上取值，
// 同层后面命中的档位整段作废（不管它填没填维度）。所以整段时段都被前面若干档
// 拼起来盖住的档位永远轮不到；只被盖住部分时段的档位仍会在剩余时段生效。
//
// 判定和网关 windowMatches 逐分钟对齐：闭区间、跨零点档位的凌晨段归前一日。
// 前提是这一档真的会被落库：网关只收 days 非空、HH:MM 合法、start ≠ end 的档位。
// 时间非法或开始=结束时保存会被服务端拒绝，这类草稿同样不参与判定。
// 将来网关若改成同层逐维合并，这里要跟着改。

type ScheduleWindow = {
  days: number[];
  start: string;
  end: string;
};

// 编辑器里的草稿：倍率在表单里是字符串，留空表示该维度不改价。
export type ScheduleDraftWindow = ScheduleWindow & {
  token_multiplier: string;
  request_multiplier: string;
};

// 落库时会被丢弃的草稿：未选星期，或两个维度都留空（表单里留空表示该维度不改价）。
// 与提交前的 payload 过滤共用一份判定，避免「编辑器说永远不会生效、保存后其实还在」。
export function isScheduleDraftDiscarded(draft: ScheduleDraftWindow): boolean {
  return draft.days.length === 0 || (draft.token_multiplier.trim() === "" && draft.request_multiplier.trim() === "");
}

// 共享常量，只读使用：调用方不得就地修改 days（Object.freeze 只冻结对象自身）。
const EMPTY_WINDOW = Object.freeze({ days: [] as number[], start: "", end: "" });

type Segment = { day: number; start: number; end: number };

// 一天里最后一分钟：网关的 minutes 取值 0..1439，跨零点档位的「当天段」到这里为止。
const LAST_MINUTE = 23 * 60 + 59;

function toMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// 把已收集的片段按天合并成不重叠的区间，才能判断「被前面几档拼起来盖住」。
// 分钟是整数值，所以前一段结束时间与后一段开始时间只差一分钟（如 06:00 与 06:01）
// 时中间没有空档，要合并；差两分钟才留缝。
function mergeSegments(segments: Segment[]): Map<number, Segment[]> {
  const raw = new Map<number, Segment[]>();
  for (const segment of segments) {
    const list = raw.get(segment.day) ?? [];
    list.push(segment);
    raw.set(segment.day, list);
  }
  const merged = new Map<number, Segment[]>();
  for (const [day, list] of raw) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    const out: Segment[] = [];
    for (const segment of sorted) {
      const last = out[out.length - 1];
      if (last && segment.start <= last.end + 1) last.end = Math.max(last.end, segment.end);
      else out.push({ ...segment });
    }
    merged.set(day, out);
  }
  return merged;
}

// 把一档展开成「星期 + 分钟区间」片段，跨零点的拆成两段并归属对应的那几天。
function expandWindow(window: ScheduleWindow): Segment[] {
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === null || end === null || start === end) return [];
  const segments: Segment[] = [];
  for (const day of window.days) {
    if (end > start) {
      segments.push({ day, start, end });
      continue;
    }
    segments.push({ day, start, end: LAST_MINUTE });
    const nextDay = day === 7 ? 1 : day + 1;
    segments.push({ day: nextDay, start: 0, end });
  }
  return segments;
}

// 返回永远拿不到生效机会的档位下标（配置顺序即优先级，靠前的档先命中）。
function findShadowedScheduleIndexes(windows: ScheduleWindow[]): Set<number> {
  const segments: Segment[] = [];
  const shadowed = new Set<number>();
  for (let i = 0; i < windows.length; i += 1) {
    const own = expandWindow(windows[i]);
    if (own.length === 0) continue;
    const coverage = mergeSegments(segments);
    const isCovered = (segment: Segment) =>
      (coverage.get(segment.day) ?? []).some((other) => other.start <= segment.start && other.end >= segment.end);
    if (own.every(isCovered)) shadowed.add(i);
    segments.push(...own);
  }
  return shadowed;
}

// 编辑器调用：落库时会被丢弃的草稿既盖不住别人，也不该标红，
// 替换成空时段跳过，下标保持不变，标红仍然落在原来那一行。
export function findShadowedDraftIndexes(drafts: ScheduleDraftWindow[]): Set<number> {
  return findShadowedScheduleIndexes(
    drafts.map((draft) => (isScheduleDraftDiscarded(draft) ? EMPTY_WINDOW : draft)),
  );
}

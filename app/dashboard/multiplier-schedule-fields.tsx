"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/shared/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const WEEKDAY_OPTIONS = [
  { value: 1, label: "一" },
  { value: 2, label: "二" },
  { value: 3, label: "三" },
  { value: 4, label: "四" },
  { value: 5, label: "五" },
  { value: 6, label: "六" },
  { value: 7, label: "日" },
] as const;

export type MultiplierScheduleDraft = {
  key: string;
  days: number[];
  start: string;
  end: string;
  token_multiplier: string;
  request_multiplier: string;
};

export function newScheduleDraft(): MultiplierScheduleDraft {
  return {
    key: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    days: [1, 2, 3, 4, 5, 6, 7],
    start: "00:00",
    end: "08:00",
    token_multiplier: "",
    request_multiplier: "",
  };
}

export function scheduleDraftsToPayload(drafts: MultiplierScheduleDraft[]): Array<{
  days: number[];
  start: string;
  end: string;
  token_multiplier: number | null;
  request_multiplier: number | null;
}> {
  const out: Array<{
    days: number[];
    start: string;
    end: string;
    token_multiplier: number | null;
    request_multiplier: number | null;
  }> = [];
  for (const draft of drafts) {
    if (draft.days.length === 0) continue;
    const tokens = draft.token_multiplier.trim() === "" ? null : Number(draft.token_multiplier);
    const requests = draft.request_multiplier.trim() === "" ? null : Number(draft.request_multiplier);
    if (tokens === null && requests === null) continue;
    out.push({
      days: draft.days,
      start: draft.start,
      end: draft.end,
      token_multiplier: tokens,
      request_multiplier: requests,
    });
  }
  return out;
}

export function schedulesToDrafts(schedules: Array<{
  days: number[];
  start: string;
  end: string;
  token_multiplier: number | null;
  request_multiplier: number | null;
}>): MultiplierScheduleDraft[] {
  return schedules.map((schedule, index) => ({
    key: `s${index}`,
    days: schedule.days,
    start: schedule.start,
    end: schedule.end,
    token_multiplier: schedule.token_multiplier === null ? "" : String(schedule.token_multiplier),
    request_multiplier: schedule.request_multiplier === null ? "" : String(schedule.request_multiplier),
  }));
}

type ScheduleWindow = Pick<MultiplierScheduleDraft, "days" | "start" | "end">;

function toMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// 把一档展开成「星期 + 分钟区间」片段，跨零点的拆成两段并归属对应的那几天。
// 判定口径与网关 windowMatches 一致：凌晨段算前一日，且两端都含。
function expandWindow(window: ScheduleWindow): Array<{ day: number; start: number; end: number }> {
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === null || end === null || start === end) return [];
  const segments: Array<{ day: number; start: number; end: number }> = [];
  for (const day of window.days) {
    if (end > start) {
      segments.push({ day, start, end });
      continue;
    }
    segments.push({ day, start, end: 24 * 60 });
    const nextDay = day === 7 ? 1 : day + 1;
    segments.push({ day: nextDay, start: 0, end });
  }
  return segments;
}

// 网关每层只在第一条命中的档位上取值，同层后面命中的档位整段作废（不管有没有填维度）。
// 所以判断「永远不会生效」只需看时段：被前面某几档拼起来盖住的时段，永远轮不到这一档。
function findShadowedSchedules(drafts: MultiplierScheduleDraft[]): Set<number> {
  const covered: Array<{ day: number; start: number; end: number }> = [];
  const shadowed = new Set<number>();
  for (let i = 0; i < drafts.length; i += 1) {
    const segments = expandWindow(drafts[i]);
    if (segments.length === 0) continue;
    const isCovered = (segment: { day: number; start: number; end: number }) =>
      covered.some((other) => other.day === segment.day && other.start <= segment.start && other.end >= segment.end);
    if (segments.every(isCovered)) shadowed.add(i);
    covered.push(...segments);
  }
  return shadowed;
}

type MultiplierScheduleFieldsProps = {
  drafts: MultiplierScheduleDraft[];
  onChange: (drafts: MultiplierScheduleDraft[]) => void;
  // 基础倍率用于提示文案；渠道级没有单一基础倍率（每个模型不同），传 null 时省略该提示。
  // 渠道级还需要额外说明与模型侧档位的优先级关系，由 hint 传入。
  baseTokenMultiplier: number | null;
  baseRequestMultiplier: number | null;
  // 渠道级额外说明生效顺序（渠道档比模型档低），模型级不需要
  hint?: string;
};

export function MultiplierScheduleFields({
  drafts,
  onChange,
  baseTokenMultiplier,
  baseRequestMultiplier,
  hint,
}: MultiplierScheduleFieldsProps) {
  const update = (key: string, patch: Partial<MultiplierScheduleDraft>) => {
    onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  };

  const shadowedIndexes = findShadowedSchedules(drafts);

  const toggleDay = (key: string, day: number) => {
    const draft = drafts.find((item) => item.key === key);
    if (!draft) return;
    const days = draft.days.includes(day)
      ? draft.days.filter((value) => value !== day)
      : [...draft.days, day].sort((a, b) => a - b);
    update(key, { days });
  };

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium text-[var(--color-foreground)]">分时倍率</p>
        <p className="text-xs text-[var(--color-foreground-muted)]">
          命中时段的请求按该档倍率计费，未命中时段沿用
          {baseTokenMultiplier === null || baseRequestMultiplier === null
            ? "基础倍率"
            : `上方基础倍率（${baseTokenMultiplier}x / ${baseRequestMultiplier}x）`}
          。时段时间按 UTC 解释，可跨零点；多档同时命中时按从上到下的顺序取第一档，后面的档位此时不生效。留空的维度沿用下层倍率。
        </p>
        {hint ? <p className="mt-1 text-xs text-[var(--color-foreground-muted)]">{hint}</p> : null}
      </div>

      {drafts.length === 0 ? (
        <p className="text-xs text-[var(--color-foreground-muted)]">未配置分时倍率，全部请求使用基础倍率。</p>
      ) : null}

      {drafts.map((draft, index) => (
        <div
          key={draft.key}
          className={cn(
            "space-y-3 rounded-lg border p-3",
            shadowedIndexes.has(index) ? "border-[var(--color-destructive)]/40" : "border-[var(--color-border)]",
          )}
        >
          <div className="space-y-2">
            <Label>生效星期</Label>
            <div className="flex flex-wrap gap-1">
              {WEEKDAY_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  size="sm"
                  variant={draft.days.includes(option.value) ? "default" : "outline"}
                  onClick={() => toggleDay(draft.key, option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label>开始时间（UTC，HH:MM）</Label>
              <Input type="time" value={draft.start} onChange={(e) => update(draft.key, { start: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>结束时间（UTC，HH:MM）</Label>
              <Input type="time" value={draft.end} onChange={(e) => update(draft.key, { end: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Token 倍率</Label>
              <Input
                type="number"
                min={0}
                step={0.1}
                value={draft.token_multiplier}
                onChange={(e) => update(draft.key, { token_multiplier: e.target.value })}
                placeholder="留空沿用基础倍率"
              />
            </div>
            <div className="space-y-2">
              <Label>请求倍率</Label>
              <Input
                type="number"
                min={0}
                step={0.1}
                value={draft.request_multiplier}
                onChange={(e) => update(draft.key, { request_multiplier: e.target.value })}
                placeholder="留空沿用基础倍率"
              />
            </div>
          </div>

          {shadowedIndexes.has(index) ? (
            <p className="text-xs text-[var(--color-destructive)]">
              该档位的时段已被上方更靠前的档位整段覆盖，永远不会生效。多档同时命中时按从上到下的顺序取第一档。
            </p>
          ) : null}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(drafts.filter((item) => item.key !== draft.key))}
          >
            移除该时段
          </Button>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={drafts.length >= 20}
        onClick={() => onChange([...drafts, newScheduleDraft()])}
      >
        添加时段
      </Button>
    </div>
  );
}

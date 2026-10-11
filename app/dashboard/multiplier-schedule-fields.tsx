"use client";

import { Button } from "@/components/ui/button";
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

type MultiplierScheduleFieldsProps = {
  drafts: MultiplierScheduleDraft[];
  onChange: (drafts: MultiplierScheduleDraft[]) => void;
  baseTokenMultiplier: number;
  baseRequestMultiplier: number;
};

export function MultiplierScheduleFields({
  drafts,
  onChange,
  baseTokenMultiplier,
  baseRequestMultiplier,
}: MultiplierScheduleFieldsProps) {
  const update = (key: string, patch: Partial<MultiplierScheduleDraft>) => {
    onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  };

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
          命中时段的请求按该档倍率计费，未命中时段沿用上方基础倍率（{baseTokenMultiplier}x / {baseRequestMultiplier}x）。时段时间按 UTC 解释，可跨零点；多档同时命中时按从上到下的顺序取第一档。留空的维度沿用基础倍率。
        </p>
      </div>

      {drafts.length === 0 ? (
        <p className="text-xs text-[var(--color-foreground-muted)]">未配置分时倍率，全部请求使用基础倍率。</p>
      ) : null}

      {drafts.map((draft) => (
        <div key={draft.key} className="space-y-3 rounded-lg border border-[var(--color-border)] p-3">
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

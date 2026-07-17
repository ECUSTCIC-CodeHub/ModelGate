"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type TimeWindowDraft = {
  days: number[]; // 1..7 周一..周日
  start: string; // HH:MM
  end: string; // HH:MM
};

const WEEKDAYS: Array<{ value: number; label: string }> = [
  { value: 1, label: "一" },
  { value: 2, label: "二" },
  { value: 3, label: "三" },
  { value: 4, label: "四" },
  { value: 5, label: "五" },
  { value: 6, label: "六" },
  { value: 7, label: "日" },
];

const EMPTY_WINDOW: TimeWindowDraft = { days: [], start: "09:00", end: "18:00" };

export function windowsToJson(windows: TimeWindowDraft[]): string {
  const cleaned = windows
    .filter((win) => win.days.length > 0 && win.start && win.end)
    .map((win) => ({
      days: [...new Set(win.days)].sort((a, b) => a - b),
      start: win.start,
      end: win.end,
    }));
  return JSON.stringify(cleaned);
}

export function jsonToWindows(raw: string | undefined | null): TimeWindowDraft[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => ({
        days: Array.isArray(item.days)
          ? (item.days as unknown[])
              .map((d) => Number(d))
              .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
          : [],
        start: typeof item.start === "string" ? item.start : "",
        end: typeof item.end === "string" ? item.end : "",
      }));
  } catch {
    return [];
  }
}

export function TimeWindowEditor({
  windows,
  onChange,
}: {
  windows: TimeWindowDraft[];
  onChange: (windows: TimeWindowDraft[]) => void;
}) {
  const [internal, setInternal] = useState<TimeWindowDraft[]>(() => windows);
  const lastEmitted = useRef<string>(windowsToJson(windows));

  useEffect(() => {
    const serialized = windowsToJson(windows);
    if (serialized !== lastEmitted.current) {
      setInternal(windows);
    }
  }, [windows]);

  function emit(next: TimeWindowDraft[]) {
    lastEmitted.current = windowsToJson(next);
    onChange(next);
  }

  function toggleDay(index: number, day: number) {
    const win = internal[index];
    const nextDays = win.days.includes(day) ? win.days.filter((d) => d !== day) : [...win.days, day];
    const next = internal.map((item, i) => (i === index ? { ...item, days: nextDays } : item));
    setInternal(next);
    emit(next);
  }

  function update(index: number, patch: Partial<TimeWindowDraft>) {
    const next = internal.map((item, i) => (i === index ? { ...item, ...patch } : item));
    setInternal(next);
    emit(next);
  }

  function remove(index: number) {
    const next = internal.filter((_, i) => i !== index);
    setInternal(next);
    emit(next);
  }

  function add() {
    const next = [...internal, { ...EMPTY_WINDOW }];
    setInternal(next);
    emit(next);
  }

  return (
    <div className="space-y-3">
      {internal.map((win, index) => (
        <div key={index} className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-3">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs">时段 #{index + 1}</Label>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(index)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex flex-wrap gap-1">
            {WEEKDAYS.map((day) => {
              const checked = win.days.includes(day.value);
              return (
                <button
                  key={day.value}
                  type="button"
                  onClick={() => toggleDay(index, day.value)}
                  className={`h-7 w-7 rounded-lg border text-xs ${
                    checked
                      ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
                      : "border-[var(--color-border)] text-[var(--color-foreground-muted)]"
                  }`}
                >
                  周{day.label}
                </button>
              );
            })}
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">开始时间</Label>
              <Input type="time" value={win.start} onChange={(e) => update(index, { start: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">结束时间</Label>
              <Input type="time" value={win.end} onChange={(e) => update(index, { end: e.target.value })} />
            </div>
          </div>
          {win.days.length > 0 && win.start && win.end && win.start === win.end && (
            <p className="text-xs text-[var(--color-danger)]">开始时间不能等于结束时间。</p>
          )}
        </div>
      ))}
      <Button type="button" variant="outline" className="w-full" onClick={add}>
        <Plus className="h-4 w-4" /> 添加时段
      </Button>
      <p className="text-xs text-[var(--color-foreground-muted)]">
        配置后渠道仅在这些时段内可用（基于服务器本地时区）。结束时间早于开始时间表示跨午夜。留空则不限制。
      </p>
    </div>
  );
}

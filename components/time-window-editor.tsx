"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { wallTimeToUtc, utcTimeToWall } from "@/lib/shared/timezone";

export type TimeWindowDraft = {
  days: number[]; // 1..7 周一..周日
  start: string; // HH:MM，编辑时区墙上时间
  end: string; // HH:MM，编辑时区墙上时间
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

// draft 的 start/end 是编辑时区墙上时间，提交时按所选时区转成 UTC 时分存库；
// days 也按 start 的 UTC 星期偏移重映射（处理跨 UTC 日，如上海周一凌晨 = UTC 周日）。
function shiftDay(day: number, shift: number): number {
  const next = ((day - 1 + shift) % 7 + 7) % 7 + 1; // 1..7 循环
  return next;
}

export function windowsToJson(windows: TimeWindowDraft[], timeZone: string): string {
  const cleaned = windows
    .filter((win) => win.days.length > 0 && win.start && win.end)
    .map((win) => {
      const startInfo = wallTimeToUtc(win.start, timeZone);
      const endInfo = wallTimeToUtc(win.end, timeZone);
      const startUtc = startInfo?.utc ?? win.start;
      const endUtc = endInfo?.utc ?? win.end;
      const shift = startInfo?.dayShift ?? 0;
      const days = [...new Set(win.days.map((d) => shiftDay(d, shift)))].sort((a, b) => a - b);
      return { days, start: startUtc, end: endUtc };
    });
  return JSON.stringify(cleaned);
}

// 库里存的是 UTC 时分，回显时按显示时区转成墙上时间（默认访问者浏览器时区）。
export function jsonToWindows(raw: string | undefined | null, timeZone: string = browserTimeZone()): TimeWindowDraft[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => {
        const rawStart = typeof item.start === "string" ? item.start : "";
        const rawEnd = typeof item.end === "string" ? item.end : "";
        return {
          days: Array.isArray(item.days)
            ? (item.days as unknown[])
                .map((d) => Number(d))
                .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
            : [],
          start: rawStart ? utcTimeToWall(rawStart, timeZone) ?? rawStart : "",
          end: rawEnd ? utcTimeToWall(rawEnd, timeZone) ?? rawEnd : "",
        };
      });
  } catch {
    return [];
  }
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timezoneOptions(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (supported && supported.length > 0) return supported;
  } catch {
    // 老浏览器降级
  }
  return ["UTC", "Asia/Shanghai", "Asia/Tokyo", "America/New_York", "America/Los_Angeles", "Europe/London"];
}

export function TimeWindowEditor({
  windows,
  onChange,
}: {
  windows: TimeWindowDraft[];
  onChange: (json: string) => void;
}) {
  const [timeZone, setTimeZone] = useState<string>(browserTimeZone);
  const tzOptions = useMemo(() => timezoneOptions(), []);
  const [internal, setInternal] = useState<TimeWindowDraft[]>(() => windows);
  const lastEmitted = useRef<string>(windowsToJson(windows, timeZone));

  useEffect(() => {
    const serialized = windowsToJson(windows, timeZone);
    if (serialized !== lastEmitted.current) {
      setInternal(windows);
    }
  }, [windows, timeZone]);

  function emit(next: TimeWindowDraft[]) {
    const json = windowsToJson(next, timeZone);
    lastEmitted.current = json;
    onChange(json);
  }

  function changeTimeZone(next: string) {
    // 保持绝对时间不变：先把草稿按旧时区转 UTC，再按新时区反算墙上时间显示。
    const prevUtc = internal.map((win) => ({
      days: win.days,
      start: wallTimeToUtc(win.start, timeZone)?.utc ?? win.start,
      end: wallTimeToUtc(win.end, timeZone)?.utc ?? win.end,
    }));
    const remapped: TimeWindowDraft[] = prevUtc.map((win) => ({
      days: win.days,
      start: utcTimeToWall(win.start, next) ?? win.start,
      end: utcTimeToWall(win.end, next) ?? win.end,
    }));
    setTimeZone(next);
    setInternal(remapped);
    const json = windowsToJson(remapped, next);
    lastEmitted.current = json;
    onChange(json);
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
      <div className="space-y-2">
        <Label className="text-xs">时段时区</Label>
        <Select value={timeZone} onValueChange={changeTimeZone}>
          <SelectTrigger className="h-9" suppressHydrationWarning>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {tzOptions.map((tz) => (
              <SelectItem key={tz} value={tz}>{tz}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-[var(--color-foreground-muted)]">输入的时段按此时区解释，存储为 UTC；不同时区的访问者看到的时段会按各自浏览器时区换算。</p>
      </div>
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
        配置后渠道仅在这些时段内可用。结束时间早于开始时间表示跨午夜。留空则不限制。
      </p>
    </div>
  );
}

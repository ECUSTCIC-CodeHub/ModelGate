"use client";

import { useMemo } from "react";
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
import { serializeTimeWindows, windowToUtc, windowToWall, type WallClockWindow } from "@/lib/shared/time-window";

// 行的 start/end 是「编辑时区」的墙上时间：提交时换成 UTC 时分存库，回显时再换回来。
// 时区由父级表单持有（time_restrictions_time_zone），否则父级按浏览器时区回填 JSON 会把
// 用户选的时区覆盖掉，下一次编辑就会二次换算。
export type TimeWindowDraft = WallClockWindow;

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
  timeZone,
  onChange,
}: {
  windows: TimeWindowDraft[];
  timeZone: string;
  onChange: (windows: TimeWindowDraft[], timeZone: string) => void;
}) {
  const tzOptions = useMemo(() => timezoneOptions(), []);
  // 换算不可行的行在这里标红；保存时由父组件用同一个函数判定并阻断
  const failed = useMemo(() => new Set(serializeTimeWindows(windows, timeZone).failed), [windows, timeZone]);

  function emit(next: TimeWindowDraft[], nextTimeZone: string = timeZone) {
    onChange(next, nextTimeZone);
  }

  function changeTimeZone(next: string) {
    // 保持绝对时间不变：先按旧时区换回 UTC（星期随跨日平移），再按新时区反算墙上时间与星期
    const moved = windows.map((win) => {
      if (win.days.length === 0 || !win.start || !win.end) return win;
      const utc = windowToUtc(win, timeZone);
      if (!utc) return win;
      return windowToWall(utc, next) ?? win;
    });
    emit(moved, next);
  }

  function toggleDay(index: number, day: number) {
    const win = windows[index];
    const nextDays = win.days.includes(day) ? win.days.filter((d) => d !== day) : [...win.days, day];
    emit(windows.map((item, i) => (i === index ? { ...item, days: nextDays } : item)));
  }

  function update(index: number, patch: Partial<TimeWindowDraft>) {
    emit(windows.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function remove(index: number) {
    emit(windows.filter((_, i) => i !== index));
  }

  function add() {
    emit([...windows, { ...EMPTY_WINDOW }]);
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
      {windows.map((win, index) => (
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
          {win.start === win.end ? (
            <p className="text-xs text-[var(--color-danger)]">开始时间不能等于结束时间。</p>
          ) : failed.has(index) ? (
            <p className="text-xs text-[var(--color-danger)]">
              该时段在 {timeZone} 下无法换算（时区不可用，或落在夏令时跳过的空档里），请调整后再保存。
            </p>
          ) : null}
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

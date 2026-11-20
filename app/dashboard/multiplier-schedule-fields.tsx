"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/shared/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { findShadowedDraftIndexes } from "@/lib/shared/multiplier-shadow";
import { browserTimeZone } from "@/lib/shared/timezone";
import type { MultiplierScheduleDraft } from "@/lib/shared/multiplier-schedule-tz";

export const WEEKDAY_OPTIONS = [
  { value: 1, label: "一" },
  { value: 2, label: "二" },
  { value: 3, label: "三" },
  { value: 4, label: "四" },
  { value: 5, label: "五" },
  { value: 6, label: "六" },
  { value: 7, label: "日" },
] as const;

// 草稿里的时分与星期都是浏览器时区的墙上时间，与「过期时间」一样只在表单里本地化；
// 载入走 schedulesToDrafts、提交走 scheduleDraftsToPayload 做换算，落库仍是 UTC。
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
  // 时区名只能在挂载后读到：首帧不带标签渲染，避免服务端与客户端输出不一致。
  // 草稿本身已经是墙上时间，输入框内容不依赖这里，不存在闪一下的情况。
  const [timeZone, setTimeZone] = useState<string | null>(null);
  useEffect(() => {
    setTimeZone(browserTimeZone());
  }, []);

  const update = (key: string, patch: Partial<MultiplierScheduleDraft>) => {
    onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  };

  // 覆盖判定按草稿（墙上时间）逐分钟对齐即可：整段平移是双射，档位之间的覆盖关系不变。
  const shadowedIndexes = findShadowedDraftIndexes(drafts);

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
          。时段时间按你的浏览器时区
          {timeZone === null ? "" : `（${timeZone}）`}
          填写，保存时自动换算为 UTC；可跨零点；多档同时命中时按从上到下的顺序取第一档，后面的档位此时不生效。留空的维度沿用下层倍率。
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
              <Label>开始时间（本地，HH:MM）</Label>
              <Input type="time" value={draft.start} onChange={(e) => update(draft.key, { start: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>结束时间（本地，HH:MM）</Label>
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
                placeholder="留空沿用下层倍率"
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
                placeholder="留空沿用下层倍率"
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

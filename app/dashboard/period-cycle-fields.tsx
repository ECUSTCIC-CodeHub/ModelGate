"use client";

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
import { PERIOD_PRESETS } from "@/lib/shared/period-format";

// 表单里的周期档：数量一律用字符串承载，空串表示「不限制」。
export type PeriodCycleDraft = {
  key: string;
  preset: string;
  custom: string;
  quota_tokens: string;
  quota_requests: string;
};

export function newCycleDraft(preset = ""): PeriodCycleDraft {
  return {
    key: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    preset,
    custom: "",
    quota_tokens: "",
    quota_requests: "",
  };
}

export function draftSeconds(draft: PeriodCycleDraft): number | null {
  if (draft.preset === "custom") {
    const value = Number(draft.custom.trim());
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }
  if (!draft.preset) return null;
  const value = Number(draft.preset);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

// 草稿 → 提交体。秒数非法或额度非法的档位跳过；两项额度都留空的档位保留，
// 语义是「该周期继承上游」（无上游即不限制），与后端校验口径一致。
// 额度填 -1 表示显式不限制。
export function draftsToPayload(drafts: PeriodCycleDraft[]): Array<{
  seconds: number;
  quota_tokens: number | null;
  quota_requests: number | null;
}> {
  const out: Array<{ seconds: number; quota_tokens: number | null; quota_requests: number | null }> = [];
  const seen = new Set<number>();
  for (const draft of drafts) {
    const seconds = draftSeconds(draft);
    if (seconds === null || seen.has(seconds)) continue;
    const tokens = parseQuotaInput(draft.quota_tokens);
    const requests = parseQuotaInput(draft.quota_requests);
    if (tokens === undefined || requests === undefined) continue;
    seen.add(seconds);
    out.push({ seconds, quota_tokens: tokens, quota_requests: requests });
  }
  return out;
}

// 额度输入：空串 → null（继承），-1 → -1（不限制），非负整数 → 数值。
// 其余输入返回 undefined，由调用方丢弃该档位。
function parseQuotaInput(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < -1) return undefined;
  return value;
}

// 已存周期 → 草稿。用于编辑回填。
export function cyclesToDrafts(cycles: Array<{ seconds: number; quota_tokens: number | null; quota_requests: number | null }>): PeriodCycleDraft[] {
  return cycles.map((cycle) => {
    const preset = PERIOD_PRESETS.some((item) => Number(item.value) === cycle.seconds) ? String(cycle.seconds) : "custom";
    return {
      key: `c${cycle.seconds}`,
      preset,
      custom: preset === "custom" ? String(cycle.seconds) : "",
      quota_tokens: cycle.quota_tokens === null ? "" : String(cycle.quota_tokens),
      quota_requests: cycle.quota_requests === null ? "" : String(cycle.quota_requests),
    };
  });
}

type PeriodCycleFieldsProps = {
  drafts: PeriodCycleDraft[];
  onChange: (drafts: PeriodCycleDraft[]) => void;
  hint?: string;
  customPlaceholder?: string;
  // inheritedHint：留空额的档位在本对象上的含义（用户档继承组档，其余对象即不限制）。
  inheritedHint?: string;
};

export function PeriodCycleFields({
  drafts,
  onChange,
  hint,
  customPlaceholder = "如 7200 = 2 小时",
  inheritedHint = "留空表示继承上游，无上游则不限制；填 -1 表示显式不限制。",
}: PeriodCycleFieldsProps) {
  const update = (key: string, patch: Partial<PeriodCycleDraft>) => {
    onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  };

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium text-[var(--color-foreground)]">周期配额</p>
        <p className="text-xs text-[var(--color-foreground-muted)]">
          {hint ?? "可同时配置多个重置周期，任一周期超出即拒绝请求。留空表示继承上游，填 -1 表示不限制。"}
        </p>
      </div>

      {drafts.length === 0 ? (
        <p className="text-xs text-[var(--color-foreground-muted)]">未配置周期配额。</p>
      ) : null}

      {drafts.map((draft) => (
        <div key={draft.key} className="grid gap-3 rounded-lg border border-[var(--color-border)] p-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label>重置周期</Label>
            <Select value={draft.preset || "none"} onValueChange={(value) => update(draft.key, {
              preset: value === "none" ? "" : value,
              custom: value === "custom" ? draft.custom : "",
            })}>
              <SelectTrigger>
                <SelectValue placeholder="未选择" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">未选择</SelectItem>
                {PERIOD_PRESETS.map((preset) => (
                  <SelectItem key={preset.value} value={preset.value}>{preset.label}</SelectItem>
                ))}
                <SelectItem value="custom">自定义</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {draft.preset === "custom" ? (
            <div className="space-y-2">
              <Label>自定义周期（秒）</Label>
              <Input
                type="number"
                min={60}
                value={draft.custom}
                onChange={(e) => update(draft.key, { custom: e.target.value })}
                placeholder={customPlaceholder}
              />
            </div>
          ) : <div />}

          <div className="space-y-2">
            <Label>周期请求配额</Label>
            <Input
              type="number"
              min={-1}
              value={draft.quota_requests}
              onChange={(e) => update(draft.key, { quota_requests: e.target.value })}
              placeholder="留空继承，-1 不限制"
            />
          </div>
          <div className="space-y-2">
            <Label>周期 Token 配额</Label>
            <Input
              type="number"
              min={-1}
              value={draft.quota_tokens}
              onChange={(e) => update(draft.key, { quota_tokens: e.target.value })}
              placeholder="留空继承，-1 不限制"
            />
          </div>
          {draft.quota_requests.trim() === "" && draft.quota_tokens.trim() === "" ? (
            <p className="text-xs text-[var(--color-foreground-muted)] md:col-span-2">{inheritedHint}</p>
          ) : null}

          <div className="md:col-span-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange(drafts.filter((item) => item.key !== draft.key))}
            >
              移除该周期
            </Button>
          </div>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={drafts.length >= 8}
        onClick={() => onChange([...drafts, newCycleDraft()])}
      >
        添加重置周期
      </Button>
    </div>
  );
}

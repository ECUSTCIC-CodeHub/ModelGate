"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parsePeriodCycles } from "@/lib/gateway/period-cycles";
import { PeriodCycleFields, cyclesToDrafts, type PeriodCycleDraft } from "@/app/dashboard/period-cycle-fields";
import type { ChannelForm } from "./channel-model";

type ChannelQuotaFieldsProps = {
  form: ChannelForm;
  periodQuotaEnabled: boolean;
  onChange: (patch: Partial<ChannelForm>) => void;
};

// 表单里的周期档由 ChannelForm.period_cycles 承载（草稿形状），提交前再折算成秒数。
export function cyclesFromForm(raw: string): PeriodCycleDraft[] {
  return cyclesToDrafts(parsePeriodCycles(raw));
}

export function ChannelQuotaFields({
  form,
  periodQuotaEnabled,
  onChange,
}: ChannelQuotaFieldsProps) {
  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
      <p className="text-sm font-medium text-[var(--color-foreground)]">渠道配额</p>
      <p className="text-xs text-[var(--color-foreground-muted)]">留空表示不限制。渠道配额独立于用户/组配额，两者同时生效。</p>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label>总请求配额</Label>
          <Input type="number" min={0} value={form.quota_requests} onChange={(e) => onChange({ quota_requests: e.target.value })} placeholder="留空不限制" />
        </div>
        <div className="space-y-2">
          <Label>总 Token 配额</Label>
          <Input type="number" min={0} value={form.quota_tokens} onChange={(e) => onChange({ quota_tokens: e.target.value })} placeholder="留空不限制" />
        </div>
      </div>
      {periodQuotaEnabled ? (
        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
          <PeriodCycleFields
            drafts={form.period_cycles}
            onChange={(drafts) => onChange({ period_cycles: drafts })}
          />
        </div>
      ) : null}
    </div>
  );
}

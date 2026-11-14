"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { parsePeriodCycles } from "@/lib/gateway/period-cycles";
import { usesChannelSelfQuota } from "@/lib/gateway/quota-mode";
import { PeriodCycleFields, cyclesToDrafts, type PeriodCycleDraft } from "@/app/dashboard/period-cycle-fields";
import { CHANNEL_QUOTA_MODE_OPTIONS, type ChannelForm } from "./channel-model";

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
  // 渠道自身配额只在独立配额 / 双重限制下参与判定；其余模式隐藏输入但保留已存值。
  const selfQuotaEnabled = usesChannelSelfQuota(form.quota_mode);

  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
      <p className="text-sm font-medium text-[var(--color-foreground)]">渠道配额</p>
      <div className="space-y-2">
        <Label>配额模式</Label>
        <Select
          value={form.quota_mode}
          onValueChange={(value) => onChange({ quota_mode: value as ChannelForm["quota_mode"] })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHANNEL_QUOTA_MODE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-[var(--color-foreground-muted)]">
          {CHANNEL_QUOTA_MODE_OPTIONS.find((option) => option.value === form.quota_mode)?.description}
        </p>
      </div>

      {selfQuotaEnabled ? (
        <>
          <p className="text-xs text-[var(--color-foreground-muted)]">留空表示不限制。渠道配额按渠道统计，与用户自身用量分开计算。</p>
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
        </>
      ) : (
        <p className="text-xs text-[var(--color-foreground-muted)]">
          当前模式不使用渠道自身配额，已保存的总配额与周期档不会生效；切回「独立配额」或「双重限制」后恢复。
        </p>
      )}
    </div>
  );
}

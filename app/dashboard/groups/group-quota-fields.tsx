"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PeriodCycleFields } from "@/app/dashboard/period-cycle-fields";
import type { GroupForm } from "./group-model";

type GroupQuotaFieldsProps = {
  form: GroupForm;
  periodQuotaEnabled: boolean;
  onChange: (patch: Partial<GroupForm>) => void;
};

export function GroupQuotaFields({
  form,
  periodQuotaEnabled,
  onChange,
}: GroupQuotaFieldsProps) {
  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
      <p className="text-sm font-medium text-[var(--color-foreground)]">配额配置</p>
      <p className="text-xs text-[var(--color-foreground-muted)]">`-1` 表示不限制。组配额作为用户的默认值，用户级设置可覆盖。</p>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-2">
          <Label>RPM</Label>
          <Input type="number" min={-1} value={form.rpm} onChange={(e) => onChange({ rpm: Number(e.target.value) })} />
        </div>
        <div className="space-y-2">
          <Label>QPS</Label>
          <Input type="number" min={-1} value={form.qps} onChange={(e) => onChange({ qps: Number(e.target.value) })} />
        </div>
        <div className="space-y-2">
          <Label>TPM</Label>
          <Input type="number" min={-1} value={form.tpm} onChange={(e) => onChange({ tpm: Number(e.target.value) })} />
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label>总请求配额</Label>
          <Input type="number" min={-1} value={form.quota_requests} onChange={(e) => onChange({ quota_requests: e.target.value })} />
        </div>
        <div className="space-y-2">
          <Label>总 Token 配额</Label>
          <Input type="number" min={-1} value={form.quota_tokens} onChange={(e) => onChange({ quota_tokens: e.target.value })} />
        </div>
      </div>
      {periodQuotaEnabled ? (
        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
          <PeriodCycleFields
            drafts={form.period_cycles}
            onChange={(drafts) => onChange({ period_cycles: drafts })}
            hint="按固定时间间隔重置用量。此处配置的是组默认值，用户未自行配置周期时继承。"
          />
        </div>
      ) : null}
    </div>
  );
}

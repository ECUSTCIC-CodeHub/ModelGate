"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatLimit } from "@/lib/shared/formatters";
import { formatPeriodLabel } from "@/lib/shared/period-format";
import { parsePeriodCycles } from "@/lib/gateway/period-cycles";
import { QuotaAmountField } from "./quota-amount-field";
import { PeriodCycleFields } from "@/app/dashboard/period-cycle-fields";
import {
  type UserForm,
  type UserGroupLimits,
} from "./user-model";

type UserQuotaFieldsProps = {
  form: UserForm;
  editingGroupLimits: UserGroupLimits | null;
  periodQuotaEnabled: boolean;
  onChange: (patch: Partial<UserForm>) => void;
};

function inheritedQuotaLabel(value: number | null) {
  return value === null ? "∞" : formatLimit(value);
}

function groupQuotaString(value: number | null): string {
  return value === null ? "" : String(value);
}

// 组档优先按新的多档列展示；只有尚未迁移的组才回退到旧单档字段。
// 两额度都为空的档位不会入库，这里仍跳过，避免出现悬空标签。
function inheritedCycleLabels(limits: UserGroupLimits): string[] {
  return parsePeriodCycles(limits.period_cycles).flatMap((cycle) => {
    const parts: string[] = [];
    if (cycle.quota_tokens !== null) parts.push(`${formatLimit(cycle.quota_tokens)} Token`);
    if (cycle.quota_requests !== null) parts.push(`${formatLimit(cycle.quota_requests)} 请求`);
    return parts.length === 0 ? [] : [`${formatPeriodLabel(cycle.seconds)}: ${parts.join(" / ")}`];
  });
}

export function UserQuotaFields({
  form,
  editingGroupLimits,
  periodQuotaEnabled,
  onChange,
}: UserQuotaFieldsProps) {
  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
      <p className="text-sm font-medium text-[var(--color-foreground)]">配额配置</p>
      <p className="text-xs text-[var(--color-foreground-muted)]">速率 `-1` 表示继承组设置（无组则不限制）；配额量可选「继承组」「不限制（覆盖组）」或「自定义数值」（0 表示禁止）。</p>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-2">
          <Label>RPM</Label>
          <Input type="number" min={-1} value={form.rpm} onChange={(e) => onChange({ rpm: Number(e.target.value) })} />
          {form.rpm < 0 && editingGroupLimits ? (
            <p className="text-xs text-[var(--color-foreground-muted)]">← 继承组: {formatLimit(editingGroupLimits.rpm)}</p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label>QPS</Label>
          <Input type="number" min={-1} value={form.qps} onChange={(e) => onChange({ qps: Number(e.target.value) })} />
          {form.qps < 0 && editingGroupLimits ? (
            <p className="text-xs text-[var(--color-foreground-muted)]">← 继承组: {formatLimit(editingGroupLimits.qps)}</p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label>TPM</Label>
          <Input type="number" min={-1} value={form.tpm} onChange={(e) => onChange({ tpm: Number(e.target.value) })} />
          {form.tpm < 0 && editingGroupLimits ? (
            <p className="text-xs text-[var(--color-foreground-muted)]">← 继承组: {formatLimit(editingGroupLimits.tpm)}</p>
          ) : null}
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <QuotaAmountField
          label="总请求配额"
          value={form.quota_requests}
          onChange={(v) => onChange({ quota_requests: v })}
          fallbackCustom={editingGroupLimits ? groupQuotaString(editingGroupLimits.quota_requests) : undefined}
          hint={
            form.quota_requests.trim() === "" && editingGroupLimits ? (
              <p className="text-xs text-[var(--color-foreground-muted)]">← 继承组: {inheritedQuotaLabel(editingGroupLimits.quota_requests)}</p>
            ) : null
          }
        />
        <QuotaAmountField
          label="总 Token 配额"
          value={form.quota_tokens}
          onChange={(v) => onChange({ quota_tokens: v })}
          fallbackCustom={editingGroupLimits ? groupQuotaString(editingGroupLimits.quota_tokens) : undefined}
          hint={
            form.quota_tokens.trim() === "" && editingGroupLimits ? (
              <p className="text-xs text-[var(--color-foreground-muted)]">← 继承组: {inheritedQuotaLabel(editingGroupLimits.quota_tokens)}</p>
            ) : null
          }
        />
      </div>
      {periodQuotaEnabled ? (
        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
          <PeriodCycleFields
            drafts={form.period_cycles}
            onChange={(drafts) => onChange({ period_cycles: drafts })}
            hint="可配置多个重置周期，任一周期超出即拒绝。留空表示该周期不限制；用户未配置任何周期时继承组周期额度。"
          />
          {form.period_cycles.length === 0 && editingGroupLimits ? (
            <p className="mt-2 text-xs text-[var(--color-foreground-muted)]">
              {inheritedCycleLabels(editingGroupLimits).length > 0
                ? `← 继承组: ${inheritedCycleLabels(editingGroupLimits).join(" / ")}`
                : `← 继承组: ${formatLimit(editingGroupLimits.period_quota_tokens)} Token / ${formatLimit(editingGroupLimits.period_quota_requests)} 请求`}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

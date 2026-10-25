"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatLimit } from "@/lib/shared/formatters";
import { formatPeriodLabel } from "@/lib/shared/period-format";
import { parsePeriodCycles } from "@/lib/gateway/period-cycles";
import { QuotaAmountField } from "./quota-amount-field";
import { PeriodCycleFields, draftSeconds } from "@/app/dashboard/period-cycle-fields";
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

// 组档按多档列展示。额度 -1 是显式不限制，null 是「未配置该档周期」。
function inheritedCycleLabels(limits: UserGroupLimits): string[] {
  return parsePeriodCycles(limits.period_cycles).flatMap((cycle) => {
    const parts: string[] = [];
    if (cycle.quota_tokens === -1) parts.push("Token 不限制");
    else if (cycle.quota_tokens !== null) parts.push(`${formatLimit(cycle.quota_tokens)} Token`);
    if (cycle.quota_requests === -1) parts.push("请求不限制");
    else if (cycle.quota_requests !== null) parts.push(`${formatLimit(cycle.quota_requests)} 请求`);
    return parts.length === 0 ? [] : [`${formatPeriodLabel(cycle.seconds)}: ${parts.join(" / ")}`];
  });
}

// 周期档的继承状态没有单独开关：组里有档位、且这些档位上没有用户自己的显式额度，
// 就是这个用户在继承组档。档位本身由 use-user-admin 按「继承/预填」生成，这里只做展示。
function inheritingSeconds(form: UserForm, limits: UserGroupLimits | null): number[] {
  if (!limits) return [];
  const own = new Set(
    form.period_cycles
      .filter((draft) => draft.quota_requests.trim() !== "" || draft.quota_tokens.trim() !== "")
      .map((draft) => draftSeconds(draft)),
  );
  return parsePeriodCycles(limits.period_cycles)
    .filter((cycle) => !own.has(cycle.seconds))
    .map((cycle) => cycle.seconds);
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
      <p className="text-xs text-[var(--color-foreground-muted)]">
        速率 -1 表示继承组设置（无组则不限制）；配额量与周期档上，留空表示继承组，-1 表示不限制（覆盖组），0 表示禁止。
      </p>
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
            inheritedHint="两项额度都留空 = 该周期继承组档位；组里也没配这一档就是这一档不限制。要覆盖组档写成 -1。"
            hint="按周期限制用量，任一周期超出即拒绝。额度留空表示继承组档位，-1 表示不限制（覆盖组），0 表示禁止。"
          />
          {editingGroupLimits && inheritedCycleLabels(editingGroupLimits).length > 0 ? (
            <p className="mt-2 text-xs text-[var(--color-foreground-muted)]">
              ← 组周期档: {inheritedCycleLabels(editingGroupLimits).join(" / ")}
              {inheritingSeconds(form, editingGroupLimits).length > 0
                ? "（额度留空的档位正在继承上述组档）"
                : null}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

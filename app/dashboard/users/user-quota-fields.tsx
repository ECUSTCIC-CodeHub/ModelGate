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
  // 已保存的用户自有周期档原文（不是表单草稿），用于判定「哪一侧正在继承组档」。
  ownPeriodCycles: string | null | undefined;
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

// 哪些周期的哪一侧正在继承组档：逐档按「用户档该侧留空」判定。
// 只看已保存的用户档（row.period_cycles），不看表单草稿 ——
// 表单里刚填的额度还没落库，拿它当「已生效的继承」会让提示与实际状态不符。
function inheritingParts(ownRaw: string | null | undefined, limits: UserGroupLimits | null): string[] {
  if (!limits) return [];
  const ownBySeconds = new Map(parsePeriodCycles(ownRaw).map((cycle) => [cycle.seconds, cycle]));
  return parsePeriodCycles(limits.period_cycles).flatMap((groupCycle) => {
    const own = ownBySeconds.get(groupCycle.seconds);
    const parts: string[] = [];
    if (own?.quota_tokens === null && groupCycle.quota_tokens !== null) parts.push("Token");
    if (own?.quota_requests === null && groupCycle.quota_requests !== null) parts.push("请求");
    return parts.length === 0 ? [] : [`${formatPeriodLabel(groupCycle.seconds)} ${parts.join("/")}`];
  });
}

export function UserQuotaFields({
  form,
  ownPeriodCycles,
  editingGroupLimits,
  periodQuotaEnabled,
  onChange,
}: UserQuotaFieldsProps) {
  const inheritedParts = inheritingParts(ownPeriodCycles, editingGroupLimits);
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
              {inheritedParts.length > 0
                ? `（正在继承组档：${inheritedParts.join("、")}）`
                : null}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

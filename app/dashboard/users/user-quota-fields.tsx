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
import { formatLimit } from "@/lib/shared/formatters";
import { QuotaAmountField } from "./quota-amount-field";
import {
  PERIOD_PRESETS,
  formatPeriodLabel,
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
          <p className="text-sm font-medium text-[var(--color-foreground)]">周期配额</p>
          <p className="mb-3 text-xs text-[var(--color-foreground-muted)]">按固定时间间隔重置用量。周期量可选「继承组」「不限制（覆盖组）」或「自定义数值」。</p>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label>重置周期</Label>
              <Select
                value={form.quota_period_preset || "none"}
                onValueChange={(value) => onChange({
                  quota_period_preset: value === "none" ? "" : value,
                  quota_period_custom: value === "custom" ? form.quota_period_custom : "",
                })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="继承组 / 不启用" />
                </SelectTrigger>
                <SelectContent>
                  {PERIOD_PRESETS.map((preset) => (
                    <SelectItem key={preset.value || "none"} value={preset.value || "none"}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.quota_period_preset === "" && editingGroupLimits ? (
                <p className="text-xs text-[var(--color-foreground-muted)]">← 继承组: {formatPeriodLabel(editingGroupLimits.quota_period)}</p>
              ) : null}
            </div>
            {form.quota_period_preset === "custom" ? (
              <div className="space-y-2">
                <Label>自定义周期（秒）</Label>
                <Input
                  type="number"
                  min={60}
                  value={form.quota_period_custom}
                  onChange={(e) => onChange({ quota_period_custom: e.target.value })}
                  placeholder="如 7200 = 2小时"
                />
              </div>
            ) : <div />}
            <QuotaAmountField
              label="周期请求配额"
              value={form.period_quota_requests}
              onChange={(v) => onChange({ period_quota_requests: v })}
              fallbackCustom={editingGroupLimits ? groupQuotaString(editingGroupLimits.period_quota_requests) : undefined}
              hint={
                form.period_quota_requests.trim() === "" && editingGroupLimits ? (
                  <p className="text-xs text-[var(--color-foreground-muted)]">← 继承组: {inheritedQuotaLabel(editingGroupLimits.period_quota_requests)}</p>
                ) : null
              }
            />
            <QuotaAmountField
              label="周期 Token 配额"
              value={form.period_quota_tokens}
              onChange={(v) => onChange({ period_quota_tokens: v })}
              fallbackCustom={editingGroupLimits ? groupQuotaString(editingGroupLimits.period_quota_tokens) : undefined}
              hint={
                form.period_quota_tokens.trim() === "" && editingGroupLimits ? (
                  <p className="text-xs text-[var(--color-foreground-muted)]">← 继承组: {inheritedQuotaLabel(editingGroupLimits.period_quota_tokens)}</p>
                ) : null
              }
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

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
import { PERIOD_PRESETS, type ChannelForm } from "./channel-model";

type ChannelQuotaFieldsProps = {
  form: ChannelForm;
  periodQuotaEnabled: boolean;
  onChange: (patch: Partial<ChannelForm>) => void;
};

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
          <p className="text-sm font-medium text-[var(--color-foreground)]">周期配额</p>
          <p className="mb-3 text-xs text-[var(--color-foreground-muted)]">按固定时间间隔重置渠道用量计数器，留空表示不启用周期配额。</p>
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
                  <SelectValue placeholder="不限制" />
                </SelectTrigger>
                <SelectContent>
                  {PERIOD_PRESETS.map((preset) => (
                    <SelectItem key={preset.value || "none"} value={preset.value || "none"}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
            <div className="space-y-2">
              <Label>周期请求配额</Label>
              <Input
                type="number"
                min={0}
                value={form.period_quota_requests}
                onChange={(e) => onChange({ period_quota_requests: e.target.value })}
                placeholder="留空不限制"
              />
            </div>
            <div className="space-y-2">
              <Label>周期 Token 配额</Label>
              <Input
                type="number"
                min={0}
                value={form.period_quota_tokens}
                onChange={(e) => onChange({ period_quota_tokens: e.target.value })}
                placeholder="留空不限制"
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

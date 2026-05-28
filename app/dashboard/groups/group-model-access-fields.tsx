"use client";

import { Checkbox } from "@/components/ui/checkbox";
import type { AliasOption, ChannelOption, GroupForm } from "./group-model";

type GroupModelAccessFieldsProps = {
  form: GroupForm;
  aliasOptions: AliasOption[];
  channelOptions: ChannelOption[];
  onToggleAllowedAlias: (alias: string) => void;
  onToggleAllowedChannel: (channelId: number) => void;
};

export function GroupModelAccessFields({
  form,
  aliasOptions,
  channelOptions,
  onToggleAllowedAlias,
  onToggleAllowedChannel,
}: GroupModelAccessFieldsProps) {
  return (
    <>
      <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
        <p className="text-sm font-medium text-[var(--color-foreground)]">模型白名单</p>
        <p className="text-xs text-[var(--color-foreground-muted)]">组级别的非公开模型白名单，与用户级白名单取并集。</p>
        <div className="grid gap-2 md:grid-cols-2">
          {aliasOptions.map((item) => (
            <label key={item.alias} className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] px-3 py-3 text-sm">
              <Checkbox
                checked={form.allowed_model_aliases.includes(item.alias)}
                onCheckedChange={() => onToggleAllowedAlias(item.alias)}
              />
              <div className="min-w-0">
                <p className="truncate font-mono text-[var(--color-foreground)]">{item.alias}</p>
              </div>
            </label>
          ))}
          {aliasOptions.length === 0 ? <p className="text-sm text-[var(--color-foreground-muted)]">暂无非公开模型可选</p> : null}
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
        <p className="text-sm font-medium text-[var(--color-foreground)]">渠道白名单</p>
        <p className="text-xs text-[var(--color-foreground-muted)]">本组用户仅能命中勾选渠道；不勾选表示允许所有渠道。</p>
        <div className="grid gap-2 md:grid-cols-2">
          {channelOptions.map((item) => (
            <label key={item.id} className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] px-3 py-3 text-sm">
              <Checkbox
                checked={form.allowed_channel_ids.includes(item.id)}
                onCheckedChange={() => onToggleAllowedChannel(item.id)}
              />
              <div className="min-w-0">
                <p className="truncate text-[var(--color-foreground)]">{item.name}{item.enabled ? "" : " (已禁用)"}</p>
              </div>
            </label>
          ))}
          {channelOptions.length === 0 ? <p className="text-sm text-[var(--color-foreground-muted)]">暂无可选渠道</p> : null}
        </div>
      </div>
    </>
  );
}

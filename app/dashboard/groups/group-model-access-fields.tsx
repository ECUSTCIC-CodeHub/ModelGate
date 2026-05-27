"use client";

import { Checkbox } from "@/components/ui/checkbox";
import type { AliasOption, GroupForm } from "./group-model";

type GroupModelAccessFieldsProps = {
  form: GroupForm;
  aliasOptions: AliasOption[];
  onToggleAllowedAlias: (alias: string) => void;
};

export function GroupModelAccessFields({
  form,
  aliasOptions,
  onToggleAllowedAlias,
}: GroupModelAccessFieldsProps) {
  return (
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
  );
}

"use client";

import { Checkbox } from "@/components/ui/checkbox";
import type { AliasOption, UserForm } from "./user-model";

type UserModelAccessFieldsProps = {
  form: UserForm;
  aliasOptions: AliasOption[];
  onToggleAllowedAlias: (alias: string) => void;
};

export function UserModelAccessFields({
  form,
  aliasOptions,
  onToggleAllowedAlias,
}: UserModelAccessFieldsProps) {
  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
      <p className="text-sm font-medium text-[var(--color-foreground)]">额外可访问模型</p>
      <p className="text-xs text-[var(--color-foreground-muted)]">这里只展示非公开模型，用于配置额外白名单授权。</p>
      <div className="grid gap-2 md:grid-cols-2">
        {aliasOptions.map((item) => (
          <label key={item.alias} className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] px-3 py-3 text-sm">
            <Checkbox
              checked={form.allowed_model_aliases.includes(item.alias)}
              onCheckedChange={() => onToggleAllowedAlias(item.alias)}
            />
            <div className="min-w-0">
              <p className="truncate font-mono text-[var(--color-foreground)]">{item.alias}</p>
              <p className="text-xs text-[var(--color-foreground-muted)]">{item.is_public === 1 ? "公开模型" : "非公开模型"}</p>
            </div>
          </label>
        ))}
        {aliasOptions.length === 0 ? <p className="text-sm text-[var(--color-foreground-muted)]">暂无模型可选</p> : null}
      </div>
    </div>
  );
}

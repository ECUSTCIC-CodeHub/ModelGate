"use client";

import type { UserOidcBinding } from "./user-model";

type UserOidcBindingPanelProps = {
  binding: UserOidcBinding | null;
};

export function UserOidcBindingPanel({ binding }: UserOidcBindingPanelProps) {
  if (!binding) return null;

  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
      <p className="text-sm font-medium text-[var(--color-foreground)]">OIDC 绑定</p>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <p className="text-xs text-[var(--color-foreground-muted)]">Issuer</p>
          <p className="truncate text-sm text-[var(--color-foreground-secondary)]" title={binding.issuer}>{binding.issuer}</p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-[var(--color-foreground-muted)]">Subject</p>
          <p className="truncate text-sm text-[var(--color-foreground-secondary)]" title={binding.subject}>{binding.subject}</p>
        </div>
      </div>
    </div>
  );
}

"use client";

import { Switch } from "@/components/ui/switch";

type ToggleRowProps = {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
};

export function ToggleRow({ title, description, checked, onCheckedChange, disabled }: ToggleRowProps) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-medium text-[var(--color-foreground)]">{title}</p>
        <p className="text-xs text-[var(--color-foreground-muted)]">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}

export function buildDisplayUrl(publicBaseUrl: string, path: string) {
  return (publicBaseUrl.replace(/\/+$/, "") || "https://your-domain.com") + path;
}

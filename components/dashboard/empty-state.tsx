import { ReactNode } from "react";
import { cn } from "@/lib/utils";

type EmptyStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-hover)] px-6 py-10 text-center",
        className,
      )}
    >
      <p className="text-sm font-medium text-[var(--color-foreground)]">{title}</p>
      {description ? <p className="mt-2 max-w-md text-sm text-[var(--color-foreground-muted)]">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

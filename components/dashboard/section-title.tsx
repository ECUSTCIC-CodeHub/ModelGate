import { ReactNode } from "react";
import { cn } from "@/lib/utils";

type SectionTitleProps = {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
};

export function SectionTitle({ title, description, action, className }: SectionTitleProps) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-[var(--color-foreground)]">{title}</h2>
        {description ? <p className="mt-1 text-sm text-[var(--color-foreground-muted)]">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

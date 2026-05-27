import { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/shared/utils";

type MetricCardProps = {
  label: string;
  value: string;
  hint?: string;
  icon?: LucideIcon;
  className?: string;
};

export function MetricCard({ label, value, hint, icon: Icon, className }: MetricCardProps) {
  return (
    <Card className={cn("overflow-hidden group", className)}>
      <CardContent className="p-3 sm:p-4 lg:p-5">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="break-words font-mono text-[11px] text-[var(--color-foreground-muted)] sm:text-xs lg:text-sm">{label}</p>
            <p className="mt-2 break-words font-mono text-base font-semibold leading-tight text-[var(--color-foreground)] sm:text-xl lg:text-2xl">
              {value}
            </p>
            {hint ? <p className="mt-1 hidden break-words text-xs text-[var(--color-foreground-muted)] lg:block">{hint}</p> : null}
          </div>
          {Icon ? (
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)] transition-colors duration-200 group-hover:border-[var(--color-accent)]/30 group-hover:text-[var(--color-accent)] lg:h-10 lg:w-10 lg:rounded-lg">
              <Icon className="h-3.5 w-3.5 lg:h-4.5 lg:w-4.5" />
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

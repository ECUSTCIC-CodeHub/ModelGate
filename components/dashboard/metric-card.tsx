import { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

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
      <CardContent className="p-4 lg:p-5">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-mono break-words text-[var(--color-foreground-muted)] lg:text-sm">{label}</p>
            <p className="mt-2 break-words text-xl font-semibold tracking-tight text-[var(--color-foreground)] lg:text-2xl font-mono">
              {value}
            </p>
            {hint ? <p className="mt-1 hidden break-words text-xs text-[var(--color-foreground-muted)] lg:block">{hint}</p> : null}
          </div>
          {Icon ? (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)] lg:h-10 lg:w-10 group-hover:text-[var(--color-accent)] group-hover:border-[var(--color-accent)]/30 transition-colors duration-200">
              <Icon className="h-4 w-4 lg:h-4.5 lg:w-4.5" />
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

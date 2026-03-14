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
    <Card className={cn("overflow-hidden", className)}>
      <CardContent className="p-4 lg:p-5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs text-zinc-400 lg:text-sm">{label}</p>
          {Icon ? (
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-zinc-400 lg:h-10 lg:w-10 lg:rounded-lg">
              <Icon className="h-3.5 w-3.5 lg:h-4 lg:w-4" />
            </div>
          ) : null}
        </div>
        <p className="mt-2 text-xl font-semibold tracking-tight text-zinc-50 lg:text-2xl">{value}</p>
        {hint ? <p className="mt-1 hidden text-xs text-zinc-500 lg:block">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

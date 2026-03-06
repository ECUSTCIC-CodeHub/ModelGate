import { DashboardRouteLoading } from "@/components/layout/dashboard-route-loading";

export default function DashboardLogsLoading() {
  return (
    <DashboardRouteLoading>
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl border border-zinc-800 bg-zinc-950/60" />
        ))}
      </div>
      <div className="mt-4 h-[calc(100%-7rem)] min-h-0 animate-pulse rounded-xl border border-zinc-800 bg-zinc-950/60" />
    </DashboardRouteLoading>
  );
}


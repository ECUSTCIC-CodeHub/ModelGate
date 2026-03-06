import { DashboardRouteLoading } from "@/components/layout/dashboard-route-loading";

export default function DashboardLoading() {
  return (
    <DashboardRouteLoading>
      <div className="grid gap-4 md:grid-cols-4 xl:grid-cols-8">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl border border-zinc-800 bg-zinc-950/60" />
        ))}
      </div>
      <div className="mt-4 grid h-[calc(100%-7rem)] min-h-0 gap-4 xl:grid-cols-3">
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 xl:col-span-2" />
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60" />
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 xl:col-span-3" />
      </div>
    </DashboardRouteLoading>
  );
}

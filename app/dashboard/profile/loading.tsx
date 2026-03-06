import { DashboardRouteLoading } from "@/components/layout/dashboard-route-loading";

export default function DashboardProfileLoading() {
  return (
    <DashboardRouteLoading>
      <div className="grid h-full min-h-0 gap-4 md:grid-cols-2">
        <div className="animate-pulse rounded-xl border border-zinc-800 bg-zinc-950/60" />
        <div className="animate-pulse rounded-xl border border-zinc-800 bg-zinc-950/60" />
      </div>
    </DashboardRouteLoading>
  );
}


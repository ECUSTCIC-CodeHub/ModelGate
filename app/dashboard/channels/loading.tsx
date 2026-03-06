import { DashboardRouteLoading } from "@/components/layout/dashboard-route-loading";

export default function DashboardChannelsLoading() {
  return (
    <DashboardRouteLoading>
      <div className="h-full min-h-0 animate-pulse rounded-xl border border-zinc-800 bg-zinc-950/60" />
    </DashboardRouteLoading>
  );
}


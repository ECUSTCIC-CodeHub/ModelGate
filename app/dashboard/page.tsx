"use client";

import { useRouter } from "next/navigation";
import { modelGateFeatures } from "@/lib/core/features";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { DashboardHeaderActions } from "./_home/dashboard-header-actions";
import { DashboardModelQuotaCard } from "./_home/dashboard-model-quota-card";
import { DashboardQuotaCard } from "./_home/dashboard-quota-card";
import { DashboardQuickActionsCard } from "./_home/dashboard-quick-actions-card";
import { DashboardSummaryCards } from "./_home/dashboard-summary-cards";
import { DashboardTokenTrendCard } from "./_home/dashboard-token-trend-card";
import { DashboardTopUsageTables } from "./_home/dashboard-top-usage-tables";
import { useDashboardHome } from "./_home/use-dashboard-home";

export default function DashboardHomePage() {
  const router = useRouter();
  const dashboard = useDashboardHome();
  const isAdmin = dashboard.role === "admin";
  const navigate = (href: string) => router.push(href);

  return (
    <DashboardShell
      role={dashboard.role}
      title="首页概览"
      subtitle="查看实时请求量、成功率与 Token 消耗表现。"
      right={<DashboardHeaderActions onNavigate={navigate} />}
    >
      <div className="space-y-4 pb-6">
        <DashboardSummaryCards loading={dashboard.loading} role={dashboard.role} summary={dashboard.summary} />
        <DashboardQuotaCard quota={dashboard.quota} />
        <DashboardModelQuotaCard modelQuotas={dashboard.modelQuotas} />

        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
          <DashboardTokenTrendCard chartReady={dashboard.chartReady} summary={dashboard.summary} />
          <DashboardQuickActionsCard isAdmin={isAdmin} announcementEnabled={modelGateFeatures.announcement} onNavigate={navigate} />
        </div>

        <DashboardTopUsageTables summary={dashboard.summary} />
      </div>
    </DashboardShell>
  );
}

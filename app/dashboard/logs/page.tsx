"use client";

import { DashboardShell } from "@/components/layout/dashboard-shell";
import { LogFiltersCard } from "./log-filters-card";
import { LogSummaryCards } from "./log-summary-cards";
import { LogTableCard } from "./log-table-card";
import { useLogAdmin } from "./use-log-admin";
import { useLogColumns } from "./use-log-columns";

export default function AdminLogsPage() {
  const logs = useLogAdmin();
  const columns = useLogColumns(logs.role);

  return (
    <DashboardShell
      role={logs.role}
      title="请求日志"
      subtitle="按时间、用户、模型与渠道追踪请求表现和故障信息。"
    >
      <div className="space-y-4 pb-6">
        <LogSummaryCards summary={logs.summary} />

        <LogFiltersCard
          role={logs.role}
          filters={logs.filters}
          loading={logs.loading}
          onFilterChange={logs.updateFilters}
          onSearch={logs.searchLogs}
          onReset={logs.resetFilters}
        />

        <LogTableCard
          columns={columns}
          rows={logs.rows}
          loading={logs.loading}
          page={logs.page}
          total={logs.total}
          pageSize={logs.pageSize}
          onPageChange={(page) => { void logs.loadLogs(page); }}
        />
      </div>
    </DashboardShell>
  );
}

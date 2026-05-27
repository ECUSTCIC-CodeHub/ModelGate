"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";
import type { Summary } from "./dashboard-model";

type TopModelRow = Summary["top_models"][number];
type TopChannelRow = Summary["top_channels"][number];

type DashboardTopUsageTablesProps = {
  summary: Summary | null;
};

export function DashboardTopUsageTables({ summary }: DashboardTopUsageTablesProps) {
  const topModelColumns = useMemo<Array<ColumnDef<TopModelRow>>>(
    () => [
      { accessorKey: "model_name", header: "模型" },
      { accessorKey: "request_count", header: "请求数", cell: ({ row }) => formatNumber(row.original.request_count) },
      {
        accessorKey: "total_tokens",
        header: "Token",
        cell: ({ row }) => <span title={formatNumber(row.original.total_tokens)}>{formatTokenCount(row.original.total_tokens)}</span>,
      },
    ],
    [],
  );

  const topChannelColumns = useMemo<Array<ColumnDef<TopChannelRow>>>(
    () => [
      { accessorKey: "channel_name", header: "渠道" },
      { accessorKey: "request_count", header: "请求数", cell: ({ row }) => formatNumber(row.original.request_count) },
      {
        accessorKey: "total_tokens",
        header: "Token",
        cell: ({ row }) => <span title={formatNumber(row.original.total_tokens)}>{formatTokenCount(row.original.total_tokens)}</span>,
      },
    ],
    [],
  );

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="min-w-0">
        <CardHeader>
          <SectionTitle title="Top 模型" description="按 Token 消耗排序。" />
        </CardHeader>
        <CardContent className="min-w-0">
          {(summary?.top_models?.length ?? 0) > 0 ? (
            <div className="max-w-full overflow-x-auto rounded-xl border border-[var(--color-border)]">
              <DataTable columns={topModelColumns} data={summary?.top_models ?? []} tableClassName="w-full sm:min-w-[420px]" />
            </div>
          ) : (
            <EmptyState title="暂无模型数据" description="开始有请求后，这里会展示最热门模型。" />
          )}
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <SectionTitle title="Top 接口渠道" description="按 Token 消耗排序。" />
        </CardHeader>
        <CardContent className="min-w-0">
          {(summary?.top_channels?.length ?? 0) > 0 ? (
            <div className="max-w-full overflow-x-auto rounded-xl border border-[var(--color-border)]">
              <DataTable columns={topChannelColumns} data={summary?.top_channels ?? []} tableClassName="w-full sm:min-w-[420px]" />
            </div>
          ) : (
            <EmptyState title="暂无渠道数据" description="接口接入并产生请求后，这里会显示渠道排行。" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

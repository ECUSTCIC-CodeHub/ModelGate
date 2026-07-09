"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/dashboard/empty-state";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";
import type { Summary } from "./dashboard-model";

type TopModelRow = Summary["top_models"][number];
type TopChannelRow = Summary["top_channels"][number];
type TopUserRow = Summary["top_users"][number];

type DashboardTopUsageTablesProps = {
  isAdmin: boolean;
  summary: Summary | null;
};

export function DashboardTopUsageTables({ isAdmin, summary }: DashboardTopUsageTablesProps) {
  const router = useRouter();
  const navigate = useCallback((href: string) => router.push(href), [router]);

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

  const topUserColumns = useMemo<Array<ColumnDef<TopUserRow>>>(
    () => [
      {
        accessorKey: "username",
        header: "用户",
        cell: ({ row }) => (
          <button
            type="button"
            className="max-w-40 truncate text-left text-[var(--color-accent)] hover:underline"
            title={row.original.username}
            onClick={() => navigate(`/dashboard/logs?user=${encodeURIComponent(row.original.username)}`)}
          >
            {row.original.username}
          </button>
        ),
      },
      { accessorKey: "request_count", header: "请求数", cell: ({ row }) => formatNumber(row.original.request_count) },
      {
        accessorKey: "total_tokens",
        header: "Token",
        cell: ({ row }) => <span title={formatNumber(row.original.total_tokens)}>{formatTokenCount(row.original.total_tokens)}</span>,
      },
      { accessorKey: "failed_requests", header: "失败", cell: ({ row }) => formatNumber(row.original.failed_requests) },
      { accessorKey: "avg_latency_ms", header: "平均延迟(ms)", cell: ({ row }) => formatNumber(Math.round(row.original.avg_latency_ms)) },
    ],
    [navigate],
  );

  return (
    <div className="flex flex-col gap-4">
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

      {isAdmin ? (
        <Card className="min-w-0">
          <CardHeader>
            <SectionTitle title="Top 用户" description="按 Token 消耗排序，点击用户名进入日志筛选。" />
          </CardHeader>
          <CardContent className="min-w-0">
            {(summary?.top_users?.length ?? 0) > 0 ? (
              <div className="max-w-full overflow-x-auto rounded-xl border border-[var(--color-border)]">
                <DataTable columns={topUserColumns} data={summary?.top_users ?? []} tableClassName="w-full sm:min-w-[640px]" />
              </div>
            ) : (
              <EmptyState title="暂无用户数据" description="开始有请求后，这里会展示消耗量最高的用户。" />
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

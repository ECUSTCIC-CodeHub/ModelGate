"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PagePagination } from "@/components/dashboard/page-pagination";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import type { LogRow } from "./log-model";

type LogTableCardProps = {
  columns: Array<ColumnDef<LogRow>>;
  rows: LogRow[];
  loading: boolean;
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
};

export function LogTableCard({
  columns,
  rows,
  loading,
  page,
  total,
  pageSize,
  onPageChange,
}: LogTableCardProps) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="请求记录"
          description="查看状态码、Token、首 Token 延迟、总耗时和错误原因。"
        />
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
            <DataTable
              columns={columns}
              data={rows}
              emptyText={loading ? "加载中..." : "暂无日志"}
            />
          </div>
        ) : (
          <EmptyState
            title={loading ? "正在加载日志" : "暂无日志数据"}
            description={loading ? "正在读取当前筛选条件下的请求记录。" : "可以调整筛选条件或等待新请求进入系统。"}
          />
        )}
        <div className="border-t border-[var(--color-border)] pt-4">
          <PagePagination
            page={page}
            total={total}
            pageSize={pageSize}
            disabled={loading}
            onPageChange={onPageChange}
          />
        </div>
      </CardContent>
    </Card>
  );
}

"use client";

import { EmptyState } from "@/components/dashboard/empty-state";
import { PagePagination } from "@/components/dashboard/page-pagination";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useResizableColumns } from "@/lib/shared/use-resizable-columns";
import { useLogColumnDefs, type LogColDef } from "./use-log-columns";
import type { LogRole, LogRow } from "./log-model";

type LogTableCardProps = {
  role: LogRole;
  rows: LogRow[];
  loading: boolean;
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
};

export function LogTableCard({
  role,
  rows,
  loading,
  page,
  total,
  pageSize,
  onPageChange,
}: LogTableCardProps) {
  const colDefs = useLogColumnDefs(role);
  const { widths, getResizeHandler } = useResizableColumns(colDefs);
  const totalMinWidth = colDefs.reduce((sum, c) => sum + c.minWidth, 0);

  const th = (col: LogColDef) => (
    <TableHead key={col.key} className="relative" style={{ width: widths[col.key] }}>
      {col.label}
      <ResizeHandle onMouseDown={getResizeHandler(col.key)} />
    </TableHead>
  );

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
            <Table className="table-fixed" style={{ minWidth: totalMinWidth }}>
              <TableHeader>
                <TableRow>
                  {colDefs.map(th)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    {colDefs.map((col) => (
                      <TableCell key={col.key}>
                        {col.render(row)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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

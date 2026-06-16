"use client";

import { useMemo } from "react";
import { ConfirmDialog } from "@/components/dashboard/confirm-dialog";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatLimit } from "@/lib/shared/formatters";
import { useResizableColumns, type ColumnWidthDef } from "@/lib/shared/use-resizable-columns";
import { formatPeriodLabel, type ChannelOption, type GroupRow } from "./group-model";

function formatAllowedChannels(ids: number[] | undefined, channelOptions: ChannelOption[]) {
  const allowedIds = ids ?? [];
  if (allowedIds.length === 0) return "全部";
  return allowedIds.map((id) => channelOptions.find((channel) => channel.id === id)?.name ?? `#${id}`).join(", ");
}

export function GroupTable({
  rows,
  periodQuotaEnabled,
  channelOptions,
  onCreate,
  onEdit,
  onRemove,
}: {
  rows: GroupRow[];
  periodQuotaEnabled: boolean;
  channelOptions: ChannelOption[];
  onCreate: () => void;
  onEdit: (row: GroupRow) => void;
  onRemove: (id: number) => void;
}) {
  const colDefs = useMemo<ColumnWidthDef[]>(
    () => [
      { key: "name", defaultWidth: 140, minWidth: 80 },
      { key: "description", defaultWidth: 140, minWidth: 80 },
      { key: "status", defaultWidth: 80, minWidth: 60 },
      { key: "isDefault", defaultWidth: 80, minWidth: 60 },
      { key: "userCount", defaultWidth: 80, minWidth: 60 },
      { key: "rateLimit", defaultWidth: 180, minWidth: 140 },
      { key: "quotaRequests", defaultWidth: 100, minWidth: 80 },
      { key: "quotaTokens", defaultWidth: 100, minWidth: 80 },
      ...(periodQuotaEnabled ? [{ key: "periodQuota", defaultWidth: 180, minWidth: 140 }] : []),
      { key: "modelWhitelist", defaultWidth: 120, minWidth: 80 },
      { key: "channelWhitelist", defaultWidth: 120, minWidth: 80 },
    ],
    [periodQuotaEnabled],
  );

  const { widths, getResizeHandler } = useResizableColumns(colDefs);
  const totalMinWidth = colDefs.reduce((sum, c) => sum + c.minWidth, 0) + 240;

  if (rows.length === 0) {
    return (
      <EmptyState
        title="暂无用户组"
        description="创建用户组来批量管理用户的限流和模型访问权限。"
        action={<Button onClick={onCreate}>新增用户组</Button>}
      />
    );
  }

  const th = (key: string, label: string, extraClass = "") => (
    <TableHead key={key} className={`relative ${extraClass}`} style={{ width: widths[key] }}>
      {label}
      <ResizeHandle onMouseDown={getResizeHandler(key)} />
    </TableHead>
  );

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
      <Table className="table-fixed" style={{ minWidth: totalMinWidth }}>
        <TableHeader>
          <TableRow>
            {th("name", "组名")}
            {th("description", "描述")}
            {th("status", "状态")}
            {th("isDefault", "默认")}
            {th("userCount", "用户数")}
            {th("rateLimit", "限速 (RPM/QPS/TPM)")}
            {th("quotaRequests", "请求配额")}
            {th("quotaTokens", "Token 配额")}
            {periodQuotaEnabled ? th("periodQuota", "周期配额") : null}
            {th("modelWhitelist", "模型白名单")}
            {th("channelWhitelist", "渠道白名单")}
            <TableHead className="text-right" style={{ width: 240 }}>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-medium">{row.name}</TableCell>
              <TableCell className="max-w-48">
                <span className="block truncate text-[var(--color-foreground-secondary)]" title={row.description ?? ""}>
                  {row.description?.trim() || "-"}
                </span>
              </TableCell>
              <TableCell>
                <Badge variant={row.enabled ? "default" : "secondary"}>{row.enabled ? "启用" : "禁用"}</Badge>
              </TableCell>
              <TableCell>
                {row.is_default ? <Badge variant="default">默认</Badge> : "-"}
              </TableCell>
              <TableCell>{row.user_count}</TableCell>
              <TableCell>{formatLimit(row.rpm)}/{formatLimit(row.qps)}/{formatLimit(row.tpm)}</TableCell>
              <TableCell>{row.quota_requests === null ? "∞" : formatLimit(row.quota_requests)}</TableCell>
              <TableCell>{row.quota_tokens === null ? "∞" : formatLimit(row.quota_tokens)}</TableCell>
              {periodQuotaEnabled ? (
                <TableCell>
                  {row.quota_period ? (
                    <div className="space-y-0.5 text-sm">
                      <p className="font-medium text-[var(--color-foreground)]">{formatPeriodLabel(row.quota_period)}</p>
                      <p className="text-xs text-[var(--color-foreground-muted)]">
                        请求 {row.period_quota_requests === null ? "∞" : formatLimit(row.period_quota_requests)}
                        {" / "}
                        Token {row.period_quota_tokens === null ? "∞" : formatLimit(row.period_quota_tokens)}
                      </p>
                    </div>
                  ) : "-"}
                </TableCell>
              ) : null}
              <TableCell className="max-w-48">
                <span className="block truncate text-[var(--color-foreground-secondary)]">
                  {row.allowed_model_aliases.length > 0 ? row.allowed_model_aliases.join(", ") : "-"}
                </span>
              </TableCell>
              <TableCell className="max-w-48">
                <span className="block truncate text-[var(--color-foreground-secondary)]" title={formatAllowedChannels(row.allowed_channel_ids, channelOptions)}>
                  {formatAllowedChannels(row.allowed_channel_ids, channelOptions)}
                </span>
              </TableCell>
              <TableCell className="space-x-2 text-right">
                <Button size="sm" variant="outline" onClick={() => onEdit(row)}>编辑</Button>
                {row.is_default ? null : (
                  <ConfirmDialog
                    title={`删除用户组 ${row.name}？`}
                    description={
                      row.user_count > 0
                        ? `该组下仍有 ${row.user_count} 个用户，需先移除或转移用户后才能删除。`
                        : "删除后不可恢复，此操作不可撤销。"
                    }
                    onConfirm={() => onRemove(row.id)}
                  />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

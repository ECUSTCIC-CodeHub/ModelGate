"use client";

import { useMemo } from "react";
import { ConfirmDialog } from "@/components/dashboard/confirm-dialog";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useResizableColumns, type ColumnWidthDef } from "@/lib/shared/use-resizable-columns";
import { parseSupportedProtocols, shortProtocolLabel, type Channel } from "./channel-model";

export function ChannelTable({
  channels,
  onCreate,
  onEdit,
  onToggle,
  onCreateModel,
  onRemove,
}: {
  channels: Channel[];
  onCreate: () => void;
  onEdit: (row: Channel) => void;
  onToggle: (row: Channel) => void;
  onCreateModel: (channelId: number) => void;
  onRemove: (id: number) => void;
}) {
  const colDefs = useMemo<ColumnWidthDef[]>(
    () => [
      { key: "index", defaultWidth: 60, minWidth: 40 },
      { key: "name", defaultWidth: 140, minWidth: 80 },
      { key: "baseUrl", defaultWidth: 140, minWidth: 80 },
      { key: "proxy", defaultWidth: 80, minWidth: 60 },
      { key: "status", defaultWidth: 80, minWidth: 60 },
      { key: "protocol", defaultWidth: 160, minWidth: 100 },
      { key: "weight", defaultWidth: 80, minWidth: 60 },
      { key: "concurrency", defaultWidth: 80, minWidth: 60 },
      { key: "timeout", defaultWidth: 80, minWidth: 60 },
      { key: "includeUsage", defaultWidth: 100, minWidth: 80 },
      { key: "modelCount", defaultWidth: 80, minWidth: 60 },
    ],
    [],
  );

  const { widths, getResizeHandler } = useResizableColumns(colDefs);
  const totalMinWidth = colDefs.reduce((sum, c) => sum + c.minWidth, 0) + 360;

  if (channels.length === 0) {
    return (
      <EmptyState
        title="暂无接口渠道"
        description="先接入一个上游 API 渠道，再继续配置模型映射。"
        action={<Button onClick={onCreate}>新增渠道</Button>}
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
            {th("index", "序号")}
            {th("name", "名称")}
            {th("baseUrl", "Base URL")}
            {th("proxy", "代理")}
            {th("status", "状态")}
            {th("protocol", "协议")}
            {th("weight", "权重")}
            {th("concurrency", "最大并发")}
            {th("timeout", "超时")}
            {th("includeUsage", "include_usage")}
            {th("modelCount", "模型数")}
            <TableHead className="text-right" style={{ width: 360 }}>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {channels.map((row, channelIndex) => (
            <TableRow key={row.id}>
              <TableCell>{channelIndex + 1}</TableCell>
              <TableCell>{row.name}</TableCell>
              <TableCell className="max-w-72 truncate">{row.base_url}</TableCell>
              <TableCell>
                <Badge variant={row.proxy_url?.trim() ? "outline" : "secondary"}>
                  {row.proxy_url?.trim() ? "已配置" : "直连"}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant={row.enabled ? "default" : "secondary"}>{row.enabled ? "启用" : "禁用"}</Badge>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {parseSupportedProtocols(row.supported_protocols).map((protocol) => (
                    <Badge key={protocol} variant="outline">{shortProtocolLabel(protocol)}</Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell>{row.weight}</TableCell>
              <TableCell>{row.max_concurrency}</TableCell>
              <TableCell>{row.timeout}s</TableCell>
              <TableCell>
                <Badge variant={row.force_include_usage === 1 ? "default" : "secondary"}>
                  {row.force_include_usage === 1 ? "开启" : "关闭"}
                </Badge>
              </TableCell>
              <TableCell>{row.models?.length ?? 0}</TableCell>
              <TableCell className="space-x-2 text-right">
                <Button size="sm" variant="outline" onClick={() => onEdit(row)}>编辑</Button>
                <Button size="sm" variant="outline" onClick={() => onToggle(row)}>
                  {row.enabled ? "禁用" : "启用"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => onCreateModel(row.id)}>新增模型</Button>
                <ConfirmDialog
                  title={`删除渠道 ${row.name}？`}
                  description="删除渠道后，其下模型映射也将失效，此操作不可撤销。"
                  onConfirm={() => onRemove(row.id)}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

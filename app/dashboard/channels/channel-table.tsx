"use client";

import { ConfirmDialog } from "@/components/dashboard/confirm-dialog";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
  if (channels.length === 0) {
    return (
      <EmptyState
        title="暂无接口渠道"
        description="先接入一个上游 API 渠道，再继续配置模型映射。"
        action={<Button onClick={onCreate}>新增渠道</Button>}
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
      <Table className="min-w-[1040px]">
        <TableHeader>
          <TableRow>
            <TableHead>序号</TableHead>
            <TableHead>名称</TableHead>
            <TableHead>Base URL</TableHead>
            <TableHead>代理</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>协议</TableHead>
            <TableHead>权重</TableHead>
            <TableHead>最大并发</TableHead>
            <TableHead>超时</TableHead>
            <TableHead>include_usage</TableHead>
            <TableHead>模型数</TableHead>
            <TableHead className="text-right">操作</TableHead>
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

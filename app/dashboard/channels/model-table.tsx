"use client";

import { useMemo } from "react";
import { ConfirmDialog } from "@/components/dashboard/confirm-dialog";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useResizableColumns, type ColumnWidthDef } from "@/lib/shared/use-resizable-columns";
import type { ModelRow, ModelWithChannel } from "./channel-model";
import { parseSupportedProtocols, shortProtocolLabel } from "./channel-model";

export function ModelTable({
  models,
  channelsCount,
  testingModelId,
  onCreate,
  onTest,
  onEdit,
  onToggle,
  onRemove,
}: {
  models: ModelWithChannel[];
  channelsCount: number;
  testingModelId: number | null;
  onCreate: () => void;
  onTest: (row: ModelRow) => void;
  onEdit: (row: ModelRow) => void;
  onToggle: (row: ModelRow) => void;
  onRemove: (id: number) => void;
}) {
  const colDefs = useMemo<ColumnWidthDef[]>(
    () => [
      { key: "index", defaultWidth: 60, minWidth: 40 },
      { key: "alias", defaultWidth: 140, minWidth: 80 },
      { key: "realModel", defaultWidth: 140, minWidth: 80 },
      { key: "channel", defaultWidth: 100, minWidth: 60 },
      { key: "protocol", defaultWidth: 160, minWidth: 100 },
      { key: "status", defaultWidth: 80, minWidth: 60 },
      { key: "visibility", defaultWidth: 80, minWidth: 60 },
      { key: "copilot", defaultWidth: 80, minWidth: 60 },
      { key: "weight", defaultWidth: 70, minWidth: 50 },
      { key: "multiplier", defaultWidth: 110, minWidth: 80 },
      { key: "concurrency", defaultWidth: 90, minWidth: 70 },
    ],
    [],
  );

  const { widths, getResizeHandler } = useResizableColumns(colDefs);
  const totalMinWidth = colDefs.reduce((sum, c) => sum + c.minWidth, 0) + 360;

  if (models.length === 0) {
    return (
      <EmptyState
        title="暂无模型映射"
        description="在渠道接入完成后，为客户端配置 alias 到真实模型的映射关系。"
        action={<Button disabled={channelsCount === 0} onClick={onCreate}>新增模型映射</Button>}
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
            {th("alias", "别名")}
            {th("realModel", "真实模型")}
            {th("channel", "所属渠道")}
            {th("protocol", "上游协议")}
            {th("status", "状态")}
            {th("visibility", "可见性")}
            {th("copilot", "Copilot")}
            {th("weight", "权重")}
            {th("multiplier", "倍率")}
            {th("concurrency", "最大并发")}
            <TableHead className="text-right" style={{ width: 360 }}>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {models.map((model, modelIndex) => (
            <TableRow key={model.id}>
              <TableCell>{modelIndex + 1}</TableCell>
              <TableCell className="max-w-72 truncate font-mono">{model.alias}</TableCell>
              <TableCell className="max-w-72 truncate">{model.real_model}</TableCell>
              <TableCell className="whitespace-nowrap">{model.channel_name}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {parseSupportedProtocols(model.supported_protocols).map((p) => (
                    <Badge key={p} variant={p === model.upstream_protocol ? "default" : "outline"}>{shortProtocolLabel(p)}</Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant={model.enabled ? "default" : "secondary"}>{model.enabled ? "启用" : "禁用"}</Badge>
              </TableCell>
              <TableCell>
                <Badge variant={model.is_public ? "default" : "secondary"}>{model.is_public ? "公开" : "白名单"}</Badge>
              </TableCell>
              <TableCell>
                <Badge variant={model.copilot_compatibility ? "default" : "secondary"}>{model.copilot_compatibility ? "兼容" : "默认"}</Badge>
              </TableCell>
              <TableCell className="whitespace-nowrap">{model.weight}</TableCell>
              <TableCell className="whitespace-nowrap">
                <span className="font-mono text-xs text-[var(--color-foreground-secondary)]">
                  T {model.token_multiplier ?? 1}x / R {model.request_multiplier ?? 1}x
                </span>
              </TableCell>
              <TableCell className="whitespace-nowrap">{model.max_concurrency > 0 ? model.max_concurrency : "继承渠道"}</TableCell>
              <TableCell className="text-right">
                <div className="flex flex-nowrap justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => onTest(model)} disabled={testingModelId === model.id}>
                    {testingModelId === model.id ? "测试中..." : "测试"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onEdit(model)}>编辑</Button>
                  <Button size="sm" variant="outline" onClick={() => onToggle(model)}>{model.enabled ? "禁用" : "启用"}</Button>
                  <ConfirmDialog
                    title={`删除模型映射 ${model.alias}？`}
                    description="删除后客户端将无法再通过该 alias 访问对应模型。"
                    onConfirm={() => onRemove(model.id)}
                  />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

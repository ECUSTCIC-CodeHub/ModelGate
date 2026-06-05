"use client";

import { ConfirmDialog } from "@/components/dashboard/confirm-dialog";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
  if (models.length === 0) {
    return (
      <EmptyState
        title="暂无模型映射"
        description="在渠道接入完成后，为客户端配置 alias 到真实模型的映射关系。"
        action={<Button disabled={channelsCount === 0} onClick={onCreate}>新增模型映射</Button>}
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
      <Table className="min-w-[1080px]">
        <TableHeader>
          <TableRow>
            <TableHead>序号</TableHead>
            <TableHead>别名</TableHead>
            <TableHead>真实模型</TableHead>
            <TableHead>所属渠道</TableHead>
            <TableHead>上游协议</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>可见性</TableHead>
            <TableHead>权重</TableHead>
            <TableHead>倍率</TableHead>
            <TableHead>最大并发</TableHead>
            <TableHead className="min-w-72 text-right">操作</TableHead>
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

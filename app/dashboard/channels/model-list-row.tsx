"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TableCell, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FlaskConical, Pencil, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ModelWithChannel } from "./channel-model";
import { parseSupportedProtocols, shortProtocolLabel } from "./channel-model";

export function ModelListRow({
  model,
  index,
  testing,
  onTest,
  onEdit,
  onToggle,
  onRemove,
}: {
  model: ModelWithChannel;
  index: number;
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const [confirmToggle, setConfirmToggle] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <TableRow>
      <TableCell className="text-[var(--color-foreground-muted)]">{index + 1}</TableCell>
      <TableCell className="max-w-48 truncate font-mono text-sm">{model.alias}</TableCell>
      <TableCell className="max-w-48 truncate text-sm text-[var(--color-foreground-muted)]">{model.real_model}</TableCell>
      <TableCell className="whitespace-nowrap text-sm">{model.channel_name}</TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {parseSupportedProtocols(model.supported_protocols).map((p) => (
            <Badge key={p} variant={p === model.upstream_protocol ? "default" : "outline"} className="text-[10px]">
              {shortProtocolLabel(p)}
            </Badge>
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
        <Badge variant={model.copilot_compatibility ? "default" : "secondary"}>
          {model.copilot_compatibility ? "兼容" : "默认"}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-nowrap">{model.weight}x</TableCell>
      <TableCell className="whitespace-nowrap font-mono text-xs text-[var(--color-foreground-secondary)]">
        T {model.token_multiplier ?? 1}x / R {model.request_multiplier ?? 1}x
      </TableCell>
      <TableCell className="whitespace-nowrap">{model.max_concurrency > 0 ? model.max_concurrency : "继承渠道"}</TableCell>
      <TableCell>
        <Switch checked={!!model.enabled} onCheckedChange={() => setConfirmToggle(true)} />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onTest} disabled={testing}>
                <FlaskConical className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{testing ? "测试中..." : "测试"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit}>
                <Pencil className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>编辑</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-[var(--color-destructive)] hover:text-[var(--color-destructive)]"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>删除</TooltipContent>
          </Tooltip>
        </div>
      </TableCell>

      <AlertDialog open={confirmToggle} onOpenChange={setConfirmToggle}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{model.enabled ? "禁用模型" : "启用模型"}</AlertDialogTitle>
            <AlertDialogDescription>
              确定{model.enabled ? "禁用" : "启用"}模型映射「{model.alias}」吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmToggle(false);
                onToggle();
              }}
            >
              确认
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除模型映射 {model.alias}？</AlertDialogTitle>
            <AlertDialogDescription>删除后客户端将无法再通过该 alias 访问对应模型，此操作不可撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDelete(false);
                onRemove();
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TableRow>
  );
}

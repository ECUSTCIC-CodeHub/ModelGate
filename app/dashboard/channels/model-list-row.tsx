"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { TableCell, TableRow } from "@/components/ui/table";
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
import { ModelActions } from "./model-actions";

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
        {model.copilot_compatibility ? (
          <Badge variant="default">Copilot 兼容</Badge>
        ) : null}
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
        <ModelActions
          model={model}
          testing={testing}
          onTest={onTest}
          onEdit={onEdit}
          onRemove={onRemove}
        />
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
    </TableRow>
  );
}

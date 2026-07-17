"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
import { parseSupportedProtocols, shortProtocolLabel, type ModelWithChannel } from "./channel-model";
import { ModelActions } from "./model-actions";

export function ModelCard({
  model,
  testing,
  onTest,
  onEdit,
  onToggle,
  onRemove,
}: {
  model: ModelWithChannel;
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const [confirmToggle, setConfirmToggle] = useState(false);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-shadow hover:shadow-[var(--shadow-md)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[var(--color-foreground)]">{model.alias}</p>
          <p className="truncate font-mono text-xs text-[var(--color-foreground-muted)]">{model.real_model}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                model.enabled ? "bg-[var(--color-success)]" : "bg-[var(--color-destructive)]"
              }`}
            />
            <span className={model.enabled ? "text-[var(--color-success)]" : "text-[var(--color-destructive)]"}>
              {model.enabled ? "启用" : "禁用"}
            </span>
          </span>
          <Switch
            checked={!!model.enabled}
            onCheckedChange={() => setConfirmToggle(true)}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Badge variant="outline">权重 {model.weight}x</Badge>
        <Badge variant="outline">
          实际 {Math.max(1, model.weight) * Math.max(1, model.channel_weight)}x
        </Badge>
        <Badge variant="outline">
          T {model.token_multiplier ?? 1}x / R {model.request_multiplier ?? 1}x
        </Badge>
        <Badge variant={model.is_public ? "default" : "secondary"}>
          {model.is_public ? "公开" : "白名单"}
        </Badge>
        {model.copilot_compatibility ? (
          <Badge variant="default">Copilot 兼容</Badge>
        ) : null}
        {model.supports_vision ? (
          <Badge variant="default">识图</Badge>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1">
        {parseSupportedProtocols(model.supported_protocols).map((p) => (
          <Badge key={p} variant={p === model.upstream_protocol ? "default" : "outline"} className="text-[10px]">
            {shortProtocolLabel(p)}
          </Badge>
        ))}
      </div>

      <div className="flex items-center justify-end gap-1 border-t border-[var(--color-border)] pt-2">
        <ModelActions
          model={model}
          testing={testing}
          onTest={onTest}
          onEdit={onEdit}
          onRemove={onRemove}
        />
      </div>

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
    </div>
  );
}

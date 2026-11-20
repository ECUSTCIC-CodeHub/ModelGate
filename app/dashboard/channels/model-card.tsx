"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { effectiveMultiplierOf, parseSupportedProtocols, shortProtocolLabel, type ModelWithChannel } from "./channel-model";
import { parseMultiplierSchedules } from "@/lib/gateway/multiplier-schedule";
import { ModelActions } from "./model-actions";
import { describeScheduleDetail, hasSchedule } from "@/lib/shared/multiplier-schedule-text";

function isExpired(exp?: string | Date | null): boolean {
  if (!exp) return false;
  const t = (exp instanceof Date ? exp : new Date(exp.replace(" ", "T"))).getTime();
  return !Number.isNaN(t) && t <= Date.now();
}

export function ModelCard({
  model,
  testing,
  onTest,
  onEdit,
  onToggle,
  onRemove,
  selection,
}: {
  model: ModelWithChannel;
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
  selection?: { checked: boolean; onToggle: () => void };
}) {
  const [confirmToggle, setConfirmToggle] = useState(false);
  // 按模型缓存：搜索、勾选等本地状态会整表重渲染，没必要每次都重算时区换算。
  // 分时标签只描述「配了什么」，与此刻是否命中无关
  const { effective, scheduleDetail } = useMemo(() => {
    const resolved = effectiveMultiplierOf(model);
    const input = {
      modelSchedules: parseMultiplierSchedules(model.multiplier_schedules),
      channelSchedules: model.channel_multiplier_schedules,
    };
    return {
      effective: resolved,
      scheduleDetail: hasSchedule(input) ? describeScheduleDetail(input) : "",
    };
  }, [model]);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-shadow hover:shadow-[var(--shadow-md)]">
      <div className="flex items-start justify-between gap-2">
        {selection ? (
          <Checkbox
            className="mt-0.5"
            checked={selection.checked}
            onCheckedChange={selection.onToggle}
            aria-label={`选择模型 ${model.alias}`}
          />
        ) : null}
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
        <Badge variant="outline">T {effective.token_multiplier}x / R {effective.request_multiplier}x</Badge>
        {scheduleDetail ? (
          // 配了分时就一直挂着标记，具体时段与倍率放在悬浮里
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="查看分时档位"
                className="inline-flex cursor-default items-center rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs font-normal text-[var(--color-accent)]"
              >
                分时
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-80 whitespace-pre-line text-xs">
              {scheduleDetail}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Badge variant={model.is_public ? "default" : "secondary"}>
          {model.is_public ? "公开" : "白名单"}
        </Badge>
        {model.supports_vision ? (
          <Badge variant="default">识图</Badge>
        ) : null}
        {isExpired(model.expires_at) ? (
          <Badge variant="destructive" title="过期模型在路由中已不可用，将在管理员下次操作任意渠道或模型后自动禁用">已过期</Badge>
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

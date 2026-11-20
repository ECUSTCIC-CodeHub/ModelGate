"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { TableCell, TableRow } from "@/components/ui/table";
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
import { parseMultiplierSchedules } from "@/lib/gateway/multiplier-schedule";
import type { ModelWithChannel } from "./channel-model";
import { effectiveMultiplierOf, parseSupportedProtocols, shortProtocolLabel } from "./channel-model";
import { ModelActions } from "./model-actions";
import { ScheduleSourceTag } from "./schedule-source-tag";
import { describeScheduleSource } from "@/lib/shared/multiplier-source";
import { describeScheduleTooltip } from "@/lib/shared/multiplier-schedule-text";

function isExpired(exp?: string | Date | null): boolean {
  if (!exp) return false;
  const t = (exp instanceof Date ? exp : new Date(exp.replace(" ", "T"))).getTime();
  return !Number.isNaN(t) && t <= Date.now();
}

export function ModelListRow({
  model,
  index,
  testing,
  onTest,
  onEdit,
  onToggle,
  onRemove,
  selection,
}: {
  model: ModelWithChannel;
  index: number;
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
  selection?: { checked: boolean; onToggle: () => void };
}) {
  const [confirmToggle, setConfirmToggle] = useState(false);
  // 生效值与档位标注必须用同一个时点，否则跨分钟时会出现「未命中」却标了「当前生效」
  const now = new Date();
  const effective = effectiveMultiplierOf(model, now);
  // 「分时」必须说清是哪一段时间、什么价：把两层档位都列出来，并标出此刻命中的那档
  const modelSchedules = parseMultiplierSchedules(model.multiplier_schedules);
  const channelSchedules = model.channel_multiplier_schedules;
  const scheduleTooltip = describeScheduleTooltip({
    baseToken: model.token_multiplier ?? 1,
    baseRequest: model.request_multiplier ?? 1,
    effectiveToken: effective.token_multiplier,
    effectiveRequest: effective.request_multiplier,
    scheduleApplied: effective.schedule_applied,
    source: effective.schedule_applied
      ? describeScheduleSource({
        tokenFromModelSchedule: effective.token_from_model_schedule,
        requestFromModelSchedule: effective.request_from_model_schedule,
        tokenScheduled: effective.token_scheduled,
        requestScheduled: effective.request_scheduled,
      })
      : undefined,
    modelSchedules,
    channelSchedules,
    now,
  });

  return (
    <TableRow className="group">
      {selection ? (
        <TableCell className="w-10">
          <Checkbox
            checked={selection.checked}
            onCheckedChange={selection.onToggle}
            aria-label={`选择模型 ${model.alias}`}
          />
        </TableCell>
      ) : null}
      <TableCell className="text-[var(--color-foreground-muted)]">{index + 1}</TableCell>
      <TableCell className="max-w-48 truncate font-mono text-sm">{model.alias}</TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 max-w-48 flex-1 truncate text-sm text-[var(--color-foreground-muted)]">{model.real_model}</span>
          {model.supports_vision ? <Badge variant="default">识图</Badge> : null}
        </div>
      </TableCell>
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
        <div className="flex flex-col items-start gap-1">
          <Badge variant={model.enabled ? "default" : "secondary"}>{model.enabled ? "启用" : "禁用"}</Badge>
          {isExpired(model.expires_at) && (
            <Badge variant="destructive" title="过期模型在路由中已不可用，将在管理员下次操作任意渠道或模型后自动禁用">已过期</Badge>
          )}
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={model.is_public ? "default" : "secondary"}>{model.is_public ? "公开" : "白名单"}</Badge>
      </TableCell>
      <TableCell className="whitespace-nowrap">{model.weight}x</TableCell>
      <TableCell className="whitespace-nowrap text-sm text-[var(--color-foreground-secondary)]">
        {Math.max(1, model.weight) * Math.max(1, model.channel_weight)}x
      </TableCell>
      <TableCell className="whitespace-nowrap font-mono text-xs">
        <Tooltip>
          <TooltipTrigger asChild>
            <div tabIndex={0} className="cursor-default text-[var(--color-foreground-secondary)]">
              T {effective.token_multiplier}x
              <ScheduleSourceTag fromModel={effective.token_from_model_schedule} scheduled={effective.token_scheduled} />
              {" / "}R {effective.request_multiplier}x
              <ScheduleSourceTag fromModel={effective.request_from_model_schedule} scheduled={effective.request_scheduled} />
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-80 whitespace-pre-line text-xs">
            {scheduleTooltip}
          </TooltipContent>
        </Tooltip>
        <p className="text-[10px] text-[var(--color-foreground-muted)]">
          基础 T {model.token_multiplier ?? 1}x / R {model.request_multiplier ?? 1}x
        </p>
      </TableCell>
      <TableCell className="whitespace-nowrap">{model.max_concurrency > 0 ? model.max_concurrency : "继承渠道"}</TableCell>
      <TableCell>
        <Switch checked={!!model.enabled} onCheckedChange={() => setConfirmToggle(true)} />
      </TableCell>
      <TableCell className="sticky right-0 z-10 w-36 bg-[var(--color-surface-solid)] shadow-[-8px_0_12px_-8px_rgba(0,0,0,0.18)] group-hover:bg-[var(--color-surface-solid-hover)]">
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

"use client";

import { useMemo, useState } from "react";
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
import { describeScheduleDetail, hasSchedule } from "@/lib/shared/multiplier-schedule-text";

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
  // 按模型缓存：搜索、勾选等本地状态会让整表重渲染，没必要每次都重算时区换算。
  // 分时标签只描述「配了什么」，与此刻是否命中无关，所以不需要跟着时间失效
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
        <div className="text-[var(--color-foreground-secondary)]">
          T {effective.token_multiplier}x / R {effective.request_multiplier}x
        </div>
        {scheduleDetail ? (
          // 配了分时就一直挂着标记，具体时段与倍率放在悬浮里，免得撑开列宽
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="查看分时档位"
                  className="mt-0.5 inline-block cursor-default text-[10px] text-[var(--color-accent)]"
                >
                  分时
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-80 whitespace-pre-line text-xs">
                {scheduleDetail}
              </TooltipContent>
            </Tooltip>
            <p className="text-[10px] text-[var(--color-foreground-muted)]">
              基础 T {model.token_multiplier ?? 1}x / R {model.request_multiplier ?? 1}x
            </p>
          </>
        ) : (
          <p className="text-[10px] text-[var(--color-foreground-muted)]">
            基础 T {model.token_multiplier ?? 1}x / R {model.request_multiplier ?? 1}x
          </p>
        )}
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

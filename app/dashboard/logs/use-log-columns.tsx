"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber, formatTokenCount, formatDatetime } from "@/lib/shared/utils";
import { ClientInfo } from "./client-info";
import { formatDuration } from "./log-formatters";
import type { LogRole, LogRow } from "./log-model";

function formatTokenSource(source: LogRow["token_source"]) {
  if (source === "usage") return "上游 usage";
  if (source === "local") return "本地统计";
  if (source === "estimated") return "预估";
  return "-";
}

function formatTokenSourceShort(source: LogRow["token_source"]) {
  if (source === "usage") return "远端";
  if (source === "local") return "本地";
  if (source === "estimated") return "预估";
  return "-";
}

function formatNullableToken(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : formatTokenCount(value);
}

function hasTokenValue(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value);
}

function TokenDetailRow({
  label,
  prompt,
  completion,
  reasoning,
  cache,
  total,
}: {
  label: string;
  prompt: number | null | undefined;
  completion: number | null | undefined;
  reasoning?: number | null | undefined;
  cache?: number | null | undefined;
  total: number | null | undefined;
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-[var(--color-foreground-muted)]">{label}</div>
      <div className="grid grid-cols-[3.5rem_1fr] gap-x-2 gap-y-0.5 font-mono text-[11px]">
        <span className="text-[var(--color-foreground-muted)]">请求</span>
        <span>{formatNullableToken(prompt)}</span>
        <span className="text-[var(--color-foreground-muted)]">响应</span>
        <span>{formatNullableToken(completion)}</span>
        <span className="text-[var(--color-foreground-muted)]">思考</span>
        <span>{formatNullableToken(reasoning)}</span>
        {hasTokenValue(cache) ? (
          <>
            <span className="text-[var(--color-foreground-muted)]">缓存</span>
            <span>{formatNullableToken(cache)}</span>
          </>
        ) : null}
        <span className="text-[var(--color-foreground-muted)]">总计</span>
        <span>{formatNullableToken(total)}</span>
      </div>
    </div>
  );
}

export function useLogColumns(role: LogRole) {
  return useMemo<Array<ColumnDef<LogRow>>>(() => {
    const cols: Array<ColumnDef<LogRow>> = [];

    cols.push({
      accessorKey: "created_at",
      header: "时间",
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-mono text-xs text-[var(--color-foreground-secondary)]">
          {formatDatetime(row.original.created_at)}
        </span>
      ),
    });

    if (role === "admin") {
      cols.push({
        accessorKey: "username",
        header: "用户",
        cell: ({ row }) => (
          <span className="block max-w-36 truncate whitespace-nowrap" title={row.original.username}>
            {row.original.username}
          </span>
        ),
      });
    }

    cols.push({
      accessorKey: "client_ip",
      header: "客户端",
      cell: ({ row }) => <ClientInfo ip={row.original.client_ip} userAgent={row.original.user_agent} />,
    });

    cols.push({
      id: "key",
      header: "密钥",
      cell: ({ row }) => {
        const masked = row.original.key_masked;
        if (!masked) return <span className="text-[var(--color-foreground-muted)]">-</span>;
        const name = row.original.key_name;
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="block max-w-44 truncate text-left font-mono text-xs text-inherit">
                {masked}
              </button>
            </TooltipTrigger>
            <TooltipContent align="start">
              <p>备注：{name && name.trim() ? name : "（无）"}</p>
            </TooltipContent>
          </Tooltip>
        );
      },
    });

    cols.push({
      id: "model",
      header: "模型",
      cell: ({ row }) => {
        const text = row.original.real_model ?? row.original.model_alias ?? "-";
        return (
          <span className="block max-w-48 truncate" title={text}>{text}</span>
        );
      },
    });

    if (role === "admin") {
      cols.push({
        accessorKey: "channel_name",
        header: "渠道",
        cell: ({ row }) => {
          const text = row.original.channel_name ?? (row.original.status_code >= 400 ? "网关拦截" : "-");
          return <span className="block max-w-40 truncate" title={text}>{text}</span>;
        },
      });
    }

    cols.push(
      {
        accessorKey: "status_code",
        header: "状态",
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <Badge variant={row.original.status_code >= 400 ? "secondary" : "default"}>
              {row.original.status_code}
            </Badge>
            <span className="text-xs text-[var(--color-foreground-muted)]">{row.original.stream ? "流式" : "普通"}</span>
            {role === "admin" && (row.original.route_attempts ?? 1) > 1 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help text-xs text-[var(--color-foreground-muted)]">·重试</span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>路由尝试 {(row.original.route_attempts ?? 1)} 次</p>
                  <p>尝试渠道：{row.original.attempted_channels ?? "-"}</p>
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: "total_tokens",
        header: "Token",
        cell: ({ row }) => {
          const promptTokens = row.original.prompt_tokens;
          const completionTokens = row.original.completion_tokens;
          const totalTokens = row.original.total_tokens ?? 0;
          const tokenUsage = row.original.metadata?.token_usage;
          const remoteUsage = tokenUsage?.remote ?? null;
          const localUsage = tokenUsage?.local ?? null;

          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="block min-w-28 whitespace-nowrap text-left text-inherit"
                  title={formatNumber(totalTokens)}
                >
                  <span className="block font-mono text-xs">
                    入 {formatTokenCount(promptTokens ?? 0)} / 出 {formatTokenCount(completionTokens ?? 0)}
                  </span>
                  <span className="block text-xs text-[var(--color-foreground-muted)]">
                    总 {formatTokenCount(totalTokens)} · {formatTokenSourceShort(row.original.token_source)}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent align="start" className="max-w-[360px]">
                <div className="space-y-3">
                  <TokenDetailRow
                    label={`采用用量 · ${formatTokenSource(row.original.token_source)}`}
                    prompt={promptTokens}
                    completion={completionTokens}
                    reasoning={remoteUsage?.reasoning_tokens ?? localUsage?.reasoning_tokens}
                    total={row.original.total_tokens}
                  />
                  <TokenDetailRow
                    label="远端 usage"
                    prompt={remoteUsage?.prompt_tokens}
                    completion={remoteUsage?.text_tokens ?? remoteUsage?.completion_tokens}
                    reasoning={remoteUsage?.reasoning_tokens}
                    cache={remoteUsage?.cache?.read_tokens}
                    total={remoteUsage?.total_tokens}
                  />
                  <TokenDetailRow
                    label="本地统计"
                    prompt={localUsage?.prompt_tokens}
                    completion={localUsage?.completion_tokens}
                    reasoning={localUsage?.reasoning_tokens}
                    total={localUsage?.total_tokens}
                  />
                </div>
              </TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        id: "performance",
        header: "耗时 / 速度",
        cell: ({ row }) => {
          const total = formatDuration(row.original.latency_ms);
          const ttft = formatDuration(row.original.first_token_latency_ms);
          const tps = typeof row.original.output_tps === "number"
            ? `${row.original.output_tps.toFixed(1)} t/s`
            : "-";
          return (
            <div className="whitespace-nowrap leading-tight">
              <div className="text-sm text-[var(--color-foreground)]">{total}</div>
              <div className="text-xs text-[var(--color-foreground-muted)]">首 {ttft} · {tps}</div>
            </div>
          );
        },
      },
      {
        accessorKey: "error_message",
        header: "失败原因",
        cell: ({ row }) => {
          if (row.original.status_code < 400) {
            return <span className="block w-full truncate text-[var(--color-foreground-muted)]">-</span>;
          }
          return (
            <span className="block w-full truncate text-[var(--color-foreground-secondary)]" title={row.original.error_message ?? "-"}>
              {row.original.error_message ?? "-"}
            </span>
          );
        },
        meta: {
          headerClassName: "w-[28rem] min-w-[28rem] max-w-[28rem]",
          cellClassName: "w-[28rem] min-w-[28rem] max-w-[28rem]",
        },
      },
    );

    return cols;
  }, [role]);
}

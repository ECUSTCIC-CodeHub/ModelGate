"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";
import { ClientInfo } from "./client-info";
import { formatDuration } from "./log-formatters";
import type { LogRole, LogRow } from "./log-model";

export function useLogColumns(role: LogRole) {
  return useMemo<Array<ColumnDef<LogRow>>>(() => {
    const cols: Array<ColumnDef<LogRow>> = [];

    cols.push({
      accessorKey: "created_at",
      header: "时间",
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-mono text-xs text-[var(--color-foreground-secondary)]">
          {new Date(row.original.created_at).toLocaleString()}
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

          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center whitespace-nowrap text-left text-inherit"
                  title={formatNumber(totalTokens)}
                >
                  <span>{formatTokenCount(totalTokens)}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent align="start">
                <p>Prompt: {formatTokenCount(promptTokens ?? 0)}</p>
                <p>Completion: {formatTokenCount(completionTokens ?? 0)}</p>
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

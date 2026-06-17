"use client";

import { type ReactNode, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber, formatTokenCount, formatDatetime } from "@/lib/shared/utils";
import type { ColumnWidthDef } from "@/lib/shared/use-resizable-columns";
import { ClientInfo } from "./client-info";
import { formatDuration } from "./log-formatters";
import type { LogRole, LogRow } from "./log-model";

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

export type LogColDef = ColumnWidthDef & {
  label: string;
  render: (row: LogRow) => ReactNode;
};

export function useLogColumnDefs(role: LogRole) {
  return useMemo<LogColDef[]>(() => {
    const cols: LogColDef[] = [];

    cols.push({
      key: "createdAt",
      defaultWidth: 170,
      minWidth: 130,
      label: "时间",
      render: (row) => (
        <span className="font-mono text-xs text-[var(--color-foreground-secondary)]">
          {formatDatetime(row.created_at)}
        </span>
      ),
    });

    if (role === "admin") {
      cols.push({
        key: "username",
        defaultWidth: 120,
        minWidth: 80,
        label: "用户",
        render: (row) => (
          <span title={row.username}>
            {row.username}
          </span>
        ),
      });
    }

    cols.push({
      key: "client",
      defaultWidth: 180,
      minWidth: 120,
      label: "客户端",
      render: (row) => <ClientInfo ip={row.client_ip} userAgent={row.user_agent} />,
    });

    cols.push({
      key: "key",
      defaultWidth: 200,
      minWidth: 120,
      label: "密钥",
      render: (row) => {
        const masked = row.key_masked;
        if (!masked) return <span className="text-[var(--color-foreground-muted)]">-</span>;
        const name = row.key_name;
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="text-left font-mono text-xs text-inherit">
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
      key: "model",
      defaultWidth: 200,
      minWidth: 120,
      label: "模型",
      render: (row) => {
        const alias = row.model_alias;
        const real = row.real_model;
        const text = alias && real && alias !== real
          ? `${alias} → ${real}`
          : (real ?? alias ?? "-");
        return (
          <span title={text}>{text}</span>
        );
      },
    });

    if (role === "admin") {
      cols.push({
        key: "channel",
        defaultWidth: 140,
        minWidth: 80,
        label: "渠道",
        render: (row) => {
          const text = row.channel_name ?? (row.status_code >= 400 ? "网关拦截" : "-");
          return <span title={text}>{text}</span>;
        },
      });
    }

    cols.push(
      {
        key: "status",
        defaultWidth: 120,
        minWidth: 80,
        label: "状态",
        render: (row) => (
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <Badge variant={row.status_code >= 400 ? "secondary" : "default"}>
              {row.status_code}
            </Badge>
            <span className="text-xs text-[var(--color-foreground-muted)]">{row.stream ? "流式" : "普通"}</span>
            {role === "admin" && (row.route_attempts ?? 1) > 1 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help text-xs text-[var(--color-foreground-muted)]">·重试</span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>路由尝试 {(row.route_attempts ?? 1)} 次</p>
                  <p>尝试渠道：{row.attempted_channels ?? "-"}</p>
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        ),
      },
      {
        key: "token",
        defaultWidth: 220,
        minWidth: 140,
        label: "Token",
        render: (row) => {
          const promptTokens = row.prompt_tokens;
          const completionTokens = row.completion_tokens;
          const totalTokens = row.total_tokens ?? 0;
          const tokenUsage = row.metadata?.token_usage;
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
                    总 {formatTokenCount(totalTokens)} · {formatTokenSourceShort(row.token_source)}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent align="start" className="max-w-[360px]">
                <div className="space-y-3">
                  <TokenDetailRow
                    label="远端 usage"
                    prompt={remoteUsage?.prompt_tokens}
                    completion={remoteUsage?.completion_tokens}
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
        key: "performance",
        defaultWidth: 140,
        minWidth: 100,
        label: "耗时 / 速度",
        render: (row) => {
          const total = formatDuration(row.latency_ms);
          const ttft = formatDuration(row.first_token_latency_ms);
          const tps = typeof row.output_tps === "number"
            ? `${row.output_tps.toFixed(1)} t/s`
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
        key: "error",
        defaultWidth: 200,
        minWidth: 120,
        label: "失败原因",
        render: (row) => {
          if (row.status_code < 400) {
            return <span className="text-[var(--color-foreground-muted)]">-</span>;
          }
          return (
            <span className="text-[var(--color-foreground-secondary)]" title={row.error_message ?? "-"}>
              {row.error_message ?? "-"}
            </span>
          );
        },
      },
    );

    return cols;
  }, [role]);
}

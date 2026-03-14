/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { authedFetch, clearSession, getCachedProfile, getOrFetchProfile } from "@/lib/client-auth";
import { formatNumber, formatTokenCount } from "@/lib/utils";

type LogRow = {
  id: number;
  username: string;
  channel_name: string | null;
  model_alias: string | null;
  real_model: string | null;
  stream: number;
  status_code: number;
  error_message: string | null;
  total_tokens: number | null;
  latency_ms: number | null;
  first_token_latency_ms: number | null;
  output_tps: number | null;
  route_attempts: number | null;
  attempted_channels: string | null;
  created_at: string;
};

type Summary = {
  total_requests: number;
  failed_requests: number;
  total_tokens: number;
  avg_latency_ms: number;
  avg_first_token_latency_ms: number;
  avg_output_tps: number;
};

function formatDuration(ms: number | null | undefined) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;

  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(2)} s`;

  const min = sec / 60;
  if (min < 60) return `${min.toFixed(2)} m`;

  const hour = min / 60;
  return `${hour.toFixed(2)} h`;
}

export default function AdminLogsPage() {
  const router = useRouter();
  const initialProfile = useAuthProfile();
  const [rows, setRows] = useState<LogRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<"admin" | "user">(() => initialProfile?.role ?? getCachedProfile()?.role ?? "user");
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [total, setTotal] = useState(0);
  const [filterUser, setFilterUser] = useState("");
  const [filterModel, setFilterModel] = useState("");
  const [filterChannel, setFilterChannel] = useState("");
  const loadSeqRef = useRef(0);

  async function load(
    nextPage = page,
    filters?: {
      user?: string;
      model?: string;
      channel?: string;
    },
  ) {
    const requestSeq = ++loadSeqRef.current;
    setLoading(true);

    const profile = await getOrFetchProfile();
    if (requestSeq !== loadSeqRef.current) return;
    if (!profile) {
      clearSession();
      router.replace("/login");
      return;
    }
    const nextRole = profile.role as "admin" | "user";
    setRole(nextRole);

    const nextFilterUser = filters?.user ?? filterUser;
    const nextFilterModel = filters?.model ?? filterModel;
    const nextFilterChannel = filters?.channel ?? filterChannel;
    const offset = (nextPage - 1) * pageSize;
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
    });
    if (nextRole === "admin" && nextFilterUser.trim()) params.set("user", nextFilterUser.trim());
    if (nextFilterModel.trim()) params.set("model", nextFilterModel.trim());
    if (nextRole === "admin" && nextFilterChannel.trim()) params.set("channel", nextFilterChannel.trim());

    const response = await authedFetch(`/api/dashboard/logs?${params.toString()}`);
    if (requestSeq !== loadSeqRef.current) return;
    if (!response.ok) {
      setLoading(false);
      return;
    }
    const data = await response.json();
    if (requestSeq !== loadSeqRef.current) return;
    setRows(data.data);
    setSummary(data.summary);
    setTotal(data.paging?.total ?? 0);
    setPage(nextPage);
    setLoading(false);
  }

  useEffect(() => {
    void load(1);
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageWindow = (() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (page <= 3) return [1, 2, 3, 4, 5];
    if (page >= totalPages - 2) return [totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [page - 2, page - 1, page, page + 1, page + 2];
  })();

  const columns = useMemo<Array<ColumnDef<LogRow>>>(() => {
    const cols: Array<ColumnDef<LogRow>> = [{
      id: "serial",
      header: "序号",
      cell: ({ row }) => (page - 1) * pageSize + row.index + 1,
    }];

    if (role === "admin") {
      cols.push({ accessorKey: "username", header: "用户" });
    }

    cols.push(
      {
        id: "model",
        header: "模型",
        cell: ({ row }) => row.original.model_alias ?? row.original.real_model ?? "-",
      },
      ...(role === "admin"
        ? [{
            accessorKey: "channel_name",
            header: "渠道",
            cell: ({ row }: { row: { original: LogRow } }) =>
              row.original.channel_name ?? (row.original.status_code >= 400 ? "网关拦截" : "-"),
          } satisfies ColumnDef<LogRow>]
        : []),
      {
        accessorKey: "stream",
        header: "类型",
        cell: ({ row }) => (row.original.stream ? "流式" : "普通"),
      },
      {
        accessorKey: "status_code",
        header: "状态",
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <Badge variant={row.original.status_code >= 400 ? "secondary" : "default"}>
              {row.original.status_code}
            </Badge>
            {role === "admin" && (row.original.route_attempts ?? 1) > 1 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help text-xs text-zinc-400">重试</span>
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
        cell: ({ row }) => <span title={formatNumber(row.original.total_tokens ?? 0)}>{formatTokenCount(row.original.total_tokens ?? 0)}</span>,
      },
      {
        accessorKey: "first_token_latency_ms",
        header: "首Token用时",
        cell: ({ row }) => formatDuration(row.original.first_token_latency_ms),
      },
      {
        accessorKey: "output_tps",
        header: "速度",
        cell: ({ row }) =>
          typeof row.original.output_tps === "number" ? `${row.original.output_tps.toFixed(2)} token/s` : "-",
      },
      {
        accessorKey: "latency_ms",
        header: "总用时",
        cell: ({ row }) => formatDuration(row.original.latency_ms),
      },
      {
        accessorKey: "error_message",
        header: "失败原因",
        cell: ({ row }) => {
          if (row.original.status_code < 400) return "-";
          return (
            <span className="block max-w-56 truncate text-zinc-300" title={row.original.error_message ?? "-"}>
              {row.original.error_message ?? "-"}
            </span>
          );
        },
      },
      {
        accessorKey: "created_at",
        header: "时间",
        cell: ({ row }) => new Date(row.original.created_at).toLocaleString(),
      },
    );

    return cols;
  }, [page, role]);

  return (
    <DashboardShell
      role={role}
      title="日志看板"
      subtitle="网关 Chat 请求、Token 和用时记录"
    >
      <div className="flex min-h-0 flex-col gap-4 md:h-full">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-5">
          <Card><CardHeader><CardDescription>总请求数</CardDescription><CardTitle>{formatNumber(summary?.total_requests)}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>失败请求数</CardDescription><CardTitle>{formatNumber(summary?.failed_requests)}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>总 Token</CardDescription><CardTitle title={formatNumber(summary?.total_tokens)}>{formatTokenCount(summary?.total_tokens)}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>平均首 Token 用时</CardDescription><CardTitle>{formatDuration(summary?.avg_first_token_latency_ms)}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>平均输出速度</CardDescription><CardTitle>{(summary?.avg_output_tps ?? 0).toFixed(2)} token/s</CardTitle></CardHeader></Card>
        </div>

        <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader className="shrink-0">
            <CardTitle>请求记录</CardTitle>
            <div className="grid gap-3 pt-2 sm:grid-cols-2 xl:grid-cols-4">
              {role === "admin" ? (
                <Input
                  placeholder="搜索用户"
                  value={filterUser}
                  onChange={(e) => setFilterUser(e.target.value)}
                />
              ) : (
                <div className="hidden xl:block" />
              )}
              <Input
                placeholder="搜索模型"
                value={filterModel}
                onChange={(e) => setFilterModel(e.target.value)}
              />
              {role === "admin" ? (
                <Input
                  placeholder="搜索渠道"
                  value={filterChannel}
                  onChange={(e) => setFilterChannel(e.target.value)}
                />
              ) : (
                <div className="hidden xl:block" />
              )}
              <div className="flex flex-wrap items-center justify-start gap-2 xl:justify-end">
                <Button variant="outline" disabled={loading} onClick={() => void load(1)}>搜索</Button>
                <Button
                  variant="ghost"
                  disabled={loading}
                  onClick={() => {
                    const emptyFilters = { user: "", model: "", channel: "" };
                    setFilterUser(emptyFilters.user);
                    setFilterModel(emptyFilters.model);
                    setFilterChannel(emptyFilters.channel);
                    void load(1, emptyFilters);
                  }}
                >
                  重置
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col px-0 pb-2 pt-0">
            <div className="min-h-0 flex-1 overflow-x-auto px-4 sm:px-6">
              <div className="h-full w-full overflow-auto rounded-md border border-zinc-800">
                <DataTable
                  columns={columns}
                  data={rows}
                  emptyText={loading ? "加载中..." : "暂无日志"}
                  tableClassName="min-w-[1280px]"
                />
              </div>
            </div>
            <div className="mt-2 flex items-center justify-end gap-3 border-t border-zinc-800 px-4 pt-2 sm:px-6">
              <Pagination className="mx-0 w-auto">
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious disabled={loading || page <= 1} onClick={() => (page > 1 ? void load(page - 1) : undefined)} />
                  </PaginationItem>

                  {pageWindow[0] > 1 ? (
                    <>
                      <PaginationItem>
                        <PaginationLink disabled={loading} onClick={() => void load(1)}>1</PaginationLink>
                      </PaginationItem>
                      {pageWindow[0] > 2 ? (
                        <PaginationItem>
                          <PaginationEllipsis />
                        </PaginationItem>
                      ) : null}
                    </>
                  ) : null}

                  {pageWindow.map((pageNo) => (
                    <PaginationItem key={pageNo}>
                      <PaginationLink disabled={loading} isActive={pageNo === page} onClick={() => void load(pageNo)}>
                        {pageNo}
                      </PaginationLink>
                    </PaginationItem>
                  ))}

                  {pageWindow[pageWindow.length - 1] < totalPages ? (
                    <>
                      {pageWindow[pageWindow.length - 1] < totalPages - 1 ? (
                        <PaginationItem>
                          <PaginationEllipsis />
                        </PaginationItem>
                      ) : null}
                      <PaginationItem>
                        <PaginationLink disabled={loading} onClick={() => void load(totalPages)}>{totalPages}</PaginationLink>
                      </PaginationItem>
                    </>
                  ) : null}

                  <PaginationItem>
                    <PaginationNext
                      disabled={loading || page >= totalPages}
                      onClick={() => (page < totalPages ? void load(page + 1) : undefined)}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}

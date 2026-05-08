/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { CalendarIcon, Clock3, Search, Timer, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/dashboard/empty-state";
import { MetricCard } from "@/components/dashboard/metric-card";
import { SectionTitle } from "@/components/dashboard/section-title";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
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
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  latency_ms: number | null;
  first_token_latency_ms: number | null;
  output_tps: number | null;
  route_attempts: number | null;
  attempted_channels: string | null;
  client_ip: string | null;
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

function parseDateValue(value: string) {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatDateValue(date?: Date) {
  return date ? format(date, "yyyy-MM-dd") : "";
}

type DateFilterProps = {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
};

function DateFilter({ value, placeholder, onChange }: DateFilterProps) {
  const selected = parseDateValue(value);

  return (
    <div className="min-w-0">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "group h-10 w-full justify-start gap-2 rounded-md bg-transparent px-3 text-left font-normal shadow-none",
              !selected ? "text-zinc-500" : "text-zinc-100",
            )}
          >
            <CalendarIcon className="h-4 w-4 text-zinc-500 transition-colors group-hover:text-zinc-300" />
            <span className="truncate">{selected ? format(selected, "yyyy-MM-dd", { locale: zhCN }) : placeholder}</span>
            {value ? (
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onChange("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    onChange("");
                  }
                }}
                className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/6 hover:text-zinc-200"
              >
                <X className="h-3.5 w-3.5" />
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-3" sideOffset={4}>
          <Calendar
            mode="single"
            selected={selected}
            onSelect={(date) => onChange(formatDateValue(date))}
            locale={zhCN}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
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
  const [filterIp, setFilterIp] = useState("");
  const [filterStartDate, setFilterStartDate] = useState("");
  const [filterEndDate, setFilterEndDate] = useState("");
  const loadSeqRef = useRef(0);

  async function load(
    nextPage = page,
    filters?: {
      user?: string;
      model?: string;
      channel?: string;
      ip?: string;
      startDate?: string;
      endDate?: string;
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
    const nextFilterIp = filters?.ip ?? filterIp;
    const nextFilterStartDate = filters?.startDate ?? filterStartDate;
    const nextFilterEndDate = filters?.endDate ?? filterEndDate;
    const offset = (nextPage - 1) * pageSize;
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
    });
    if (nextRole === "admin" && nextFilterUser.trim()) params.set("user", nextFilterUser.trim());
    if (nextFilterModel.trim()) params.set("model", nextFilterModel.trim());
    if (nextRole === "admin" && nextFilterChannel.trim()) params.set("channel", nextFilterChannel.trim());
    if (nextFilterIp.trim()) params.set("ip", nextFilterIp.trim());
    if (nextFilterStartDate) params.set("start_date", nextFilterStartDate);
    if (nextFilterEndDate) params.set("end_date", nextFilterEndDate);

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
    const cols: Array<ColumnDef<LogRow>> = [];

    cols.push({
      accessorKey: "created_at",
      header: "时间",
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-mono text-xs text-zinc-300">
          {new Date(row.original.created_at).toLocaleString()}
        </span>
      ),
    });

    if (role === "admin") {
      cols.push({
        accessorKey: "username",
        header: "用户",
        cell: ({ row }) => {
          const ip = row.original.client_ip;
          return (
            <span className="whitespace-nowrap">
              {row.original.username}{ip ? <span className="text-zinc-500"> ({ip})</span> : null}
            </span>
          );
        },
      });
    } else {
      cols.push({
        accessorKey: "client_ip",
        header: "IP",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-zinc-400">{row.original.client_ip ?? "-"}</span>
        ),
      });
    }

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
            <span className="text-xs text-zinc-500">{row.original.stream ? "流式" : "普通"}</span>
            {role === "admin" && (row.original.route_attempts ?? 1) > 1 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help text-xs text-zinc-400">·重试</span>
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
              <div className="text-sm text-zinc-100">{total}</div>
              <div className="text-xs text-zinc-500">首 {ttft} · {tps}</div>
            </div>
          );
        },
      },
      {
        accessorKey: "error_message",
        header: "失败原因",
        cell: ({ row }) => {
          if (row.original.status_code < 400) return <span className="text-zinc-500">-</span>;
          return (
            <span className="block max-w-56 truncate text-zinc-300" title={row.original.error_message ?? "-"}>
              {row.original.error_message ?? "-"}
            </span>
          );
        },
      },
    );

    return cols;
  }, [role]);

  return (
    <DashboardShell
      role={role}
      title="请求日志"
      subtitle="按时间、用户、模型与渠道追踪请求表现和故障信息。"
    >
      <div className="space-y-4 pb-6">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          <MetricCard label="总请求数" value={formatNumber(summary?.total_requests)} hint="当前筛选范围内的请求量" icon={Search} />
          <MetricCard label="失败请求数" value={formatNumber(summary?.failed_requests)} hint="便于快速定位异常" icon={Search} />
          <MetricCard label="总 Token" value={formatTokenCount(summary?.total_tokens)} hint={summary ? `完整值 ${formatNumber(summary.total_tokens)}` : "累计 Token 消耗"} icon={Search} />
          <MetricCard label="平均首 Token" value={formatDuration(summary?.avg_first_token_latency_ms)} hint="首个 token 返回速度" icon={Timer} />
          <MetricCard label="平均输出速度" value={`${(summary?.avg_output_tps ?? 0).toFixed(2)} t/s`} hint="用于判断上游模型质量" icon={Clock3} />
        </div>

        <Card>
          <CardHeader className="pb-3">
            <SectionTitle title="筛选条件" />
          </CardHeader>
          <CardContent className="space-y-3">
            <div
              className={
                role === "admin"
                  ? "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_180px_180px_auto]"
                  : "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_180px_180px_auto]"
              }
            >
              {role === "admin" ? (
                <Input placeholder="搜索用户" value={filterUser} onChange={(e) => setFilterUser(e.target.value)} />
              ) : null}
              <Input placeholder="搜索模型" value={filterModel} onChange={(e) => setFilterModel(e.target.value)} />
              {role === "admin" ? (
                <Input placeholder="搜索渠道" value={filterChannel} onChange={(e) => setFilterChannel(e.target.value)} />
              ) : null}
              <Input placeholder="搜索 IP" value={filterIp} onChange={(e) => setFilterIp(e.target.value)} />
              <DateFilter value={filterStartDate} placeholder="开始日期" onChange={setFilterStartDate} />
              <DateFilter value={filterEndDate} placeholder="结束日期" onChange={setFilterEndDate} />
              <div className="flex items-center gap-2 whitespace-nowrap xl:justify-end">
                <Button variant="outline" disabled={loading} onClick={() => void load(1)}>查询</Button>
                <Button
                  variant="ghost"
                  disabled={loading}
                  onClick={() => {
                    const emptyFilters = { user: "", model: "", channel: "", ip: "", startDate: "", endDate: "" };
                    setFilterUser(emptyFilters.user);
                    setFilterModel(emptyFilters.model);
                    setFilterChannel(emptyFilters.channel);
                    setFilterIp(emptyFilters.ip);
                    setFilterStartDate(emptyFilters.startDate);
                    setFilterEndDate(emptyFilters.endDate);
                    void load(1, emptyFilters);
                  }}
                >
                  重置
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <SectionTitle
              title="请求记录"
              description="查看状态码、Token、首 Token 延迟、总耗时和错误原因。"
            />
          </CardHeader>
          <CardContent className="space-y-4">
            {rows.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border border-white/10">
                <DataTable
                  columns={columns}
                  data={rows}
                  emptyText={loading ? "加载中..." : "暂无日志"}
                />
              </div>
            ) : (
              <EmptyState
                title={loading ? "正在加载日志" : "暂无日志数据"}
                description={loading ? "正在读取当前筛选条件下的请求记录。" : "可以调整筛选条件或等待新请求进入系统。"}
              />
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
              <p className="text-sm text-zinc-400">
                共 {formatNumber(total)} 条，第 {page} / {totalPages} 页
              </p>
              <Pagination className="mx-0 w-auto">
                <PaginationContent className="flex-wrap gap-1">
                  <PaginationItem>
                    <PaginationPrevious disabled={loading || page <= 1} onClick={() => (page > 1 ? void load(page - 1) : undefined)} />
                  </PaginationItem>

                  {pageWindow[0] > 1 ? (
                    <>
                      <PaginationItem className="hidden sm:list-item">
                        <PaginationLink disabled={loading} onClick={() => void load(1)}>1</PaginationLink>
                      </PaginationItem>
                      {pageWindow[0] > 2 ? (
                        <PaginationItem className="hidden sm:list-item">
                          <PaginationEllipsis />
                        </PaginationItem>
                      ) : null}
                    </>
                  ) : null}

                  {pageWindow.map((pageNo) => (
                    <PaginationItem key={pageNo} className="hidden sm:list-item">
                      <PaginationLink disabled={loading} isActive={pageNo === page} onClick={() => void load(pageNo)}>
                        {pageNo}
                      </PaginationLink>
                    </PaginationItem>
                  ))}

                  {pageWindow[pageWindow.length - 1] < totalPages ? (
                    <>
                      {pageWindow[pageWindow.length - 1] < totalPages - 1 ? (
                        <PaginationItem className="hidden sm:list-item">
                          <PaginationEllipsis />
                        </PaginationItem>
                      ) : null}
                      <PaginationItem className="hidden sm:list-item">
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

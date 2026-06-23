"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { ChevronDown, Copy, LayoutGrid, List, Search, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { SectionTitle } from "@/components/dashboard/section-title";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/shared/utils";
import { getApiMessage } from "@/lib/shared/api-message";
import { authedFetch, ensureLoggedIn, getCachedProfile } from "@/lib/auth/client-auth";

type ChannelMultiplier = {
  channel_id: number;
  channel_name: string;
  token_multiplier: number;
  request_multiplier: number;
  effective_weight: number;
};

type ModelItem = {
  id: string;
  object: "model";
  token_multiplier: number;
  request_multiplier: number;
  token_multiplier_min: number;
  token_multiplier_max: number;
  request_multiplier_min: number;
  request_multiplier_max: number;
  max_effective_weight: number;
  channels: ChannelMultiplier[];
};

type SortField = "id" | "token_multiplier" | "request_multiplier";
type SortOrder = "asc" | "desc";

type ModelMetrics = {
  avg_latency_ms: number;
  avg_output_tps: number;
  hourly: Array<{ hour: number; success_rate: number; request_count: number }>;
};

const ENDPOINTS = [
  { label: "Chat Completions (OpenAI)", path: "/api/v1/chat/completions", method: "POST" },
  { label: "Chat (Ollama)", path: "/api/ollama/api/chat", method: "POST" },
  { label: "Responses (OpenAI)", path: "/api/v1/responses", method: "POST" },
  { label: "Messages (Anthropic Claude)", path: "/api/v1/messages", method: "POST" },
  { label: "Embeddings (OpenAI)", path: "/api/v1/embeddings", method: "POST" },
  { label: "Images Generations (OpenAI)", path: "/api/v1/images/generations", method: "POST" },
  { label: "Images Edits (OpenAI)", path: "/api/v1/images/edits", method: "POST" },
] as const;


export default function AvailableModelsPage() {
  const router = useRouter();
  const initialProfile = useAuthProfile();
  const [role, setRole] = useState<"admin" | "user">(() => initialProfile?.role ?? getCachedProfile()?.role ?? "user");
  const [rows, setRows] = useState<ModelItem[]>([]);
  const [metricsMap, setMetricsMap] = useState<Record<string, ModelMetrics>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [noticeHtml, setNoticeHtml] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"card" | "list">("card");
  const [sortField, setSortField] = useState<SortField>("id");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const { toast } = useToast();

  useEffect(() => {
    const saved = localStorage.getItem("modelGuideView");
    if (saved === "card" || saved === "list") setView(saved);
  }, []);

  function changeView(v: "card" | "list") {
    setView(v);
    localStorage.setItem("modelGuideView", v);
  }

  useEffect(() => {
    void (async () => {
      try {
        const response = await authedFetch("/api/dashboard/access-guide-notice");
        if (!response.ok) return;
        const data = await response.json();
        const content = (data?.content ?? "").trim();
        if (!content) return;
        const rendered = await marked.parse(content);
        setNoticeHtml(DOMPurify.sanitize(rendered));
      } catch {
        // silently ignore
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const profile = await ensureLoggedIn(router);
        if (cancelled || !profile) return;
        setRole(profile.role as "admin" | "user");

        const response = await authedFetch("/api/dashboard/available-models");
        const data = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          const message = getApiMessage(data, "加载可用模型失败。");
          setError(message);
          toast({ variant: "error", description: message });
          return;
        }

        setRows(data?.data ?? []);

        // Non-blocking metrics fetch
        authedFetch("/api/dashboard/model-metrics")
          .then((res) => (res.ok ? res.json() : null))
          .then((metricsData) => {
            if (metricsData?.data) setMetricsMap(metricsData.data as Record<string, ModelMetrics>);
          })
          .catch(() => {});
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void init();
    return () => { cancelled = true; };
  }, [router, toast]);

  function copyText(text: string) {
    void navigator.clipboard.writeText(text).then(() => {
      toast({ variant: "success", description: "已复制到剪贴板" });
    });
  }

  function toggleSortOrder() {
    setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
  }

  function handleSort(field: SortField) {
    if (sortField === field) toggleSortOrder();
    else { setSortField(field); setSortOrder("asc"); }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.id.toLowerCase().includes(q));
  }, [rows, search]);

  const sorted = useMemo(() => {
    const sorted = [...filtered].sort((a, b) => {
      let cmp: number;
      if (sortField === "id") {
        cmp = a.id.localeCompare(b.id);
      } else if (sortField === "token_multiplier") {
        cmp = a.token_multiplier - b.token_multiplier;
      } else {
        cmp = a.request_multiplier - b.request_multiplier;
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [filtered, sortField, sortOrder]);

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  function renderMultiplier(row: ModelItem, type: "token" | "request") {
    const multiplier = type === "token" ? row.token_multiplier : row.request_multiplier;
    const min = type === "token" ? row.token_multiplier_min : row.request_multiplier_min;
    const max = type === "token" ? row.token_multiplier_max : row.request_multiplier_max;
    const hasRange = min !== max;
    const hasMultipleChannels = row.channels.length > 1;
    const popoverTitle = type === "token" ? "各渠道 Token 倍率" : "各渠道请求倍率";

    if (hasMultipleChannels) {
      return (
        <Popover>
          <PopoverTrigger asChild>
            <button className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-mono hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer">
              <span className={hasRange ? "text-[var(--color-accent)] font-semibold" : "text-[var(--color-foreground-muted)]"}>
                {hasRange ? min + "x ~ " + max + "x" : multiplier + "x"}
              </span>
              <ChevronDown className="h-3.5 w-3.5 text-[var(--color-foreground-muted)]" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-3" align="center">
            <div className="space-y-2">
              <p className="text-xs font-medium text-[var(--color-foreground-muted)]">{popoverTitle}</p>
              <div className="space-y-1">
                {row.channels.map((ch) => {
                  const chMultiplier = type === "token" ? ch.token_multiplier : ch.request_multiplier;
                  return (
                    <div key={ch.channel_id} className="flex items-center justify-between text-xs">
                      <span className="text-[var(--color-foreground-secondary)] truncate max-w-[120px]">{ch.channel_name}</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[var(--color-foreground-muted)]">W{ch.effective_weight}</span>
                        <span className={cn("font-mono", chMultiplier !== 1 ? "text-[var(--color-accent)] font-semibold" : "text-[var(--color-foreground-muted)]")}>
                          {chMultiplier}x
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      );
    }

    return (
      <span className={cn("font-mono text-sm", multiplier !== 1 ? "text-[var(--color-accent)] font-semibold" : "text-[var(--color-foreground-muted)]")}>
        {multiplier}x
      </span>
    );
  }

  return (
    <DashboardShell
      role={role}
      title="接入指南"
      subtitle="一站式查看接入配置、协议端点与当前账号可调用的模型列表。"
    >
      <div className="space-y-4 pb-6">
        {noticeHtml ? (
          <Card>
            <CardContent className="pt-6">
              <div
                className="markdown-body"
                dangerouslySetInnerHTML={{ __html: noticeHtml }}
              />
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <SectionTitle
              title="接入配置"
              description="将 Base URL 填入客户端配置，使用 API Key 和模型 ID 即可调用；网关同时兼容下方协议端点。"
            />
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3">
              <p className="text-xs font-medium text-[var(--color-foreground-muted)]">Base URL（OpenAI）</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-[var(--color-surface-hover)] px-3 py-2 text-sm text-[var(--color-foreground)]">{origin}/api/v1</code>
                <Button type="button" variant="outline" size="sm" onClick={() => copyText(`${origin}/api/v1`)}>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  复制
                </Button>
              </div>
              <p className="text-xs text-[var(--color-foreground-muted)]">适用于 OpenAI SDK 等客户端的 base_url / api_base 配置项。</p>
            </div>

            <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3">
              <p className="text-xs font-medium text-[var(--color-foreground-muted)]">ANTHROPIC_BASE_URL</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-[var(--color-surface-hover)] px-3 py-2 text-sm text-[var(--color-foreground)]">{origin}/api</code>
                <Button type="button" variant="outline" size="sm" onClick={() => copyText(`${origin}/api`)}>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  复制
                </Button>
              </div>
              <p className="text-xs text-[var(--color-foreground-muted)]">适用于 Anthropic SDK 等客户端的 ANTHROPIC_BASE_URL 配置项。</p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-[var(--color-foreground-muted)]">协议端点</p>
              <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
                <Table className="min-w-[600px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>协议</TableHead>
                      <TableHead>端点地址</TableHead>
                      <TableHead className="w-16" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ENDPOINTS.map((ep) => (
                      <TableRow key={ep.path}>
                        <TableCell className="text-sm font-medium text-[var(--color-foreground)]">{ep.label}</TableCell>
                        <TableCell>
                          <code className="rounded bg-[var(--color-surface-hover)] px-2 py-1 text-xs text-[var(--color-foreground-secondary)]">{origin}{ep.path}</code>
                        </TableCell>
                        <TableCell>
                          <Button size="sm" variant="ghost" onClick={() => copyText(`${origin}${ep.path}`)}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-[var(--color-foreground-muted)]">协议端点共用同一 API Key；模型 ID 填写对应协议可用的模型映射。</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <SectionTitle
              title="模型列表"
              description="模型 ID 用于请求中的 model 字段，需匹配对应协议可用的模型映射。"
            />
          </CardHeader>
          <CardContent className="space-y-4">
            {error ? <p className="text-sm text-[var(--color-destructive)]">{error}</p> : null}
            {rows.length > 0 ? (
              <>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-foreground-muted)]" />
                    <Input
                      className="pl-9"
                      placeholder="搜索模型 ID"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <div className="flex items-center gap-1 rounded-md border border-[var(--color-border)] p-0.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn("h-8 w-8 rounded-sm", view === "list" && "bg-[var(--color-surface-hover)] text-[var(--color-foreground)]")}
                          onClick={() => changeView("list")}
                          aria-label="列表视图"
                          aria-pressed={view === "list"}
                        >
                          <List className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>列表视图</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn("h-8 w-8 rounded-sm", view === "card" && "bg-[var(--color-surface-hover)] text-[var(--color-foreground)]")}
                          onClick={() => changeView("card")}
                          aria-label="卡片视图"
                          aria-pressed={view === "card"}
                        >
                          <LayoutGrid className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>卡片视图</TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                {sorted.length === 0 ? (
                  <p className="py-8 text-center text-sm text-[var(--color-foreground-muted)]">未找到匹配的模型。</p>
                ) : view === "list" ? (
                  <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
                    <Table className="min-w-[460px]">
                      <TableHeader>
                        <TableRow>
                          <SortButton
                            label="模型 ID"
                            field="id"
                            currentField={sortField}
                            order={sortOrder}
                            onClick={() => handleSort("id")}
                          />
                          <SortButton
                            label="Token 倍率"
                            field="token_multiplier"
                            currentField={sortField}
                            order={sortOrder}
                            onClick={() => handleSort("token_multiplier")}
                          />
                          <SortButton
                            label="请求倍率"
                            field="request_multiplier"
                            currentField={sortField}
                            order={sortOrder}
                            onClick={() => handleSort("request_multiplier")}
                          />
                          <TableHead className="w-16" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sorted.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell className="font-mono text-sm">{row.id}</TableCell>
                            <TableCell className="text-center">
                              {renderMultiplier(row, "token")}
                            </TableCell>
                            <TableCell className="text-center">
                              {renderMultiplier(row, "request")}
                            </TableCell>
                            <TableCell>
                              <Button size="sm" variant="ghost" onClick={() => copyText(row.id)}>
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {sorted.map((row) => {
                      const hasTokenRange = row.token_multiplier_min !== row.token_multiplier_max;
                      const hasRequestRange = row.request_multiplier_min !== row.request_multiplier_max;
                      const hasMultipleChannels = row.channels.length > 1;

                      return (
                        <div
                          key={row.id}
                          className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-shadow hover:shadow-[var(--shadow-md)]"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-[var(--color-foreground)] font-mono">{row.id}</p>
                              {hasMultipleChannels ? (
                                <p className="text-xs text-[var(--color-foreground-muted)] mt-0.5">{row.channels.length} 个渠道</p>
                              ) : (
                                <p className="truncate text-xs text-[var(--color-foreground-muted)] mt-0.5">{row.channels[0]?.channel_name ?? "未知渠道"}</p>
                              )}
                            </div>
                            <Button size="sm" variant="ghost" onClick={() => copyText(row.id)} className="h-7 w-7 p-0">
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </div>

                          <div className="flex items-center justify-between gap-2">
                            <div className="flex flex-wrap gap-1.5">
                              <span className={cn(
                                "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono",
                                row.token_multiplier !== 1
                                  ? "border-[var(--color-accent)]/20 bg-[var(--color-accent-muted)] text-[var(--color-accent)]"
                                  : "border-[var(--color-border)] bg-[var(--color-surface-hover)] text-[var(--color-foreground-secondary)]"
                              )}>
                                Token {hasTokenRange ? row.token_multiplier_min + "x~" + row.token_multiplier_max + "x" : row.token_multiplier + "x"}
                              </span>
                              <span className={cn(
                                "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono",
                                row.request_multiplier !== 1
                                  ? "border-[var(--color-accent)]/20 bg-[var(--color-accent-muted)] text-[var(--color-accent)]"
                                  : "border-[var(--color-border)] bg-[var(--color-surface-hover)] text-[var(--color-foreground-secondary)]"
                              )}>
                                请求 {hasRequestRange ? row.request_multiplier_min + "x~" + row.request_multiplier_max + "x" : row.request_multiplier + "x"}
                              </span>
                            </div>
                            {(() => {
                              const metrics = metricsMap[row.id];
                              if (!metrics) return null;
                              const latencyLabel = metrics.avg_latency_ms >= 1000
                                ? `${(metrics.avg_latency_ms / 1000).toFixed(1)}s`
                                : `${metrics.avg_latency_ms}ms`;
                              const tpsLabel = `${metrics.avg_output_tps}tps`;
                              return (
                                <div className="flex items-center gap-2 text-xs font-mono text-[var(--color-foreground-muted)]">
                                  <span>{latencyLabel}</span>
                                  <span>{tpsLabel}</span>
                                  <div className="flex items-center gap-0.5">
                                    {[2, 1, 0].map((h) => {
                                      const bucket = metrics.hourly.find((b) => b.hour === h);
                                      const rate = bucket?.success_rate ?? 0;
                                      const count = bucket?.request_count ?? 0;
                                      const color =
                                        count === 0
                                          ? "bg-gray-300 dark:bg-gray-600"
                                          : rate >= 90
                                            ? "bg-emerald-500"
                                            : rate >= 70
                                              ? "bg-amber-500"
                                              : "bg-red-500";
                                      const label = count === 0
                                        ? `${h === 0 ? "最近1h" : h === 1 ? "第2h" : "第3h"}: 无数据`
                                        : `${h === 0 ? "最近1h" : h === 1 ? "第2h" : "第3h"}: ${rate}% (${count}次)`;
                                      return (
                                        <Tooltip key={h}>
                                          <TooltipTrigger asChild>
                                            <span className={`inline-block h-4 w-1 rounded-sm ${color}`} />
                                          </TooltipTrigger>
                                          <TooltipContent side="top" className="text-xs">
                                            {label}
                                          </TooltipContent>
                                        </Tooltip>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })()}
                          </div>

                          {hasMultipleChannels ? (
                            <div className="space-y-1 border-t border-[var(--color-border)] pt-2">
                              {row.channels.map((ch) => (
                                <div key={ch.channel_id} className="flex items-center justify-between text-xs">
                                  <span className="text-[var(--color-foreground-secondary)] truncate max-w-[140px]">{ch.channel_name}</span>
                                  <div className="flex items-center gap-2">
                                    <span className="font-mono text-[var(--color-foreground-muted)]">W{ch.effective_weight}</span>
                                    <span className={cn("font-mono", ch.token_multiplier !== 1 && "text-[var(--color-accent)] font-semibold")}>T{ch.token_multiplier}x</span>
                                    <span className={cn("font-mono", ch.request_multiplier !== 1 && "text-[var(--color-accent)] font-semibold")}>R{ch.request_multiplier}x</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <EmptyState
                title={loading ? "正在加载模型列表" : "暂无可用模型"}
                description={loading ? "正在读取当前账号可访问的模型。" : "请检查渠道与模型配置，或确认当前账号是否被授予模型访问权限。"}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}

function SortButton({
  label,
  field,
  currentField,
  order,
  onClick,
}: {
  label: string;
  field: SortField;
  currentField: SortField;
  order: SortOrder;
  onClick: () => void;
}) {
  const active = field === currentField;
  return (
    <TableHead
      role="button"
      tabIndex={0}
      className="text-center cursor-pointer select-none"
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          order === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 opacity-40" />
        )}
      </span>
    </TableHead>
  );
}

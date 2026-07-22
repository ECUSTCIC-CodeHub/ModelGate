"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Copy, LayoutGrid, List, Search, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { SectionTitle } from "@/components/dashboard/section-title";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/shared/utils";
import { getApiMessage } from "@/lib/shared/api-message";
import { authedFetch, ensureLoggedIn, getCachedProfile } from "@/lib/auth/client-auth";
import { protocolOptions, shortProtocolLabel, type Protocol } from "@/app/dashboard/channels/channel-model";

type ChannelMultiplier = {
  channel_id: number;
  channel_name: string;
  real_model: string;
  token_multiplier: number;
  request_multiplier: number;
  effective_weight: number;
};

type BrandGroup = {
  label: string;
  pattern: string;
};

const OTHER_BRAND = "其他";

function compileBrandMatcher(pattern: string): RegExp | null {
  const trimmed = pattern.trim();
  if (!trimmed) return null;
  const escaped = trimmed.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*");
  return new RegExp("^" + escaped, "i");
}

function matchBrandGroups(id: string, matchers: Array<{ label: string; matcher: RegExp }>): string {
  for (const group of matchers) {
    if (group.matcher.test(id)) return group.label;
  }
  return OTHER_BRAND;
}

type ModelItem = {
  id: string;
  object: "model";
  supports_vision: boolean;
  supported_protocols: Protocol[];
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
  hourly: Array<{ hours: number; success_rate: number; request_count: number }>;
};

export default function AvailableModelsPage() {
  const router = useRouter();
  const initialProfile = useAuthProfile();
  const [role, setRole] = useState<"admin" | "user">(() => initialProfile?.role ?? getCachedProfile()?.role ?? "user");
  const [rows, setRows] = useState<ModelItem[]>([]);
  const [metricsMap, setMetricsMap] = useState<Record<string, ModelMetrics>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"card" | "list">("card");
  const [sortField, setSortField] = useState<SortField>("id");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const [protocolFilter, setProtocolFilter] = useState<Set<Protocol>>(() => new Set());
  const [brandGroups, setBrandGroups] = useState<BrandGroup[]>([]);
  const [brandFilter, setBrandFilter] = useState<Set<string>>(() => new Set());
  const { toast } = useToast();

  function toggleProtocol(value: Protocol) {
    setProtocolFilter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function clearProtocolFilter() {
    setProtocolFilter(new Set());
  }

  function toggleBrand(value: string) {
    setBrandFilter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function clearBrandFilter() {
    setBrandFilter(new Set());
  }

  useEffect(() => {
    const saved = localStorage.getItem("modelGuideView");
    if (saved === "card" || saved === "list") setView(saved);
  }, []);

  function changeView(v: "card" | "list") {
    setView(v);
    localStorage.setItem("modelGuideView", v);
  }

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
        if (Array.isArray(data?.brand_groups)) {
          setBrandGroups(data.brand_groups.filter(
            (g: unknown): g is BrandGroup => !!g && typeof g === "object" && typeof (g as BrandGroup).label === "string" && typeof (g as BrandGroup).pattern === "string",
          ));
        }

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

  const brandMatchers = useMemo(() => {
    return brandGroups
      .map((g) => ({ label: g.label, matcher: compileBrandMatcher(g.pattern) }))
      .filter((g): g is { label: string; matcher: RegExp } => g.matcher !== null);
  }, [brandGroups]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const hasBrandGroups = brandMatchers.length > 0;
    return rows.filter((r) => {
      if (q && !r.id.toLowerCase().includes(q)) return false;
      if (protocolFilter.size > 0) {
        const modelProtocols = r.supported_protocols ?? [];
        let protocolHit = false;
        for (const p of protocolFilter) {
          if (modelProtocols.includes(p)) { protocolHit = true; break; }
        }
        if (!protocolHit) return false;
      }
      if (hasBrandGroups && brandFilter.size > 0) {
        const brand = matchBrandGroups(r.id, brandMatchers);
        if (!brandFilter.has(brand)) return false;
      }
      return true;
    });
  }, [rows, search, protocolFilter, brandMatchers, brandFilter]);

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
      title="模型列表"
      subtitle="查看当前账号可调用的模型与倍率。"
    >
      <div className="space-y-4 pb-6">
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

                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn("h-8 rounded-full px-3 text-xs", protocolFilter.size === 0 && "bg-[var(--color-surface-hover)] text-[var(--color-foreground)]")}
                    onClick={clearProtocolFilter}
                    aria-pressed={protocolFilter.size === 0}
                  >
                    全部协议
                  </Button>
                  {protocolOptions.map((opt) => {
                    const active = protocolFilter.has(opt.value);
                    return (
                      <Button
                        key={opt.value}
                        variant="ghost"
                        size="sm"
                        className={cn("h-8 rounded-full px-3 text-xs", active && "bg-[var(--color-surface-hover)] text-[var(--color-foreground)]")}
                        onClick={() => toggleProtocol(opt.value)}
                        aria-pressed={active}
                      >
                        {opt.shortLabel}
                      </Button>
                    );
                  })}
                </div>

                {brandGroups.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn("h-8 rounded-full px-3 text-xs", brandFilter.size === 0 && "bg-[var(--color-surface-hover)] text-[var(--color-foreground)]")}
                      onClick={clearBrandFilter}
                      aria-pressed={brandFilter.size === 0}
                    >
                      全部品牌
                    </Button>
                    {(() => {
                      const labels = [...new Set(brandGroups.map((g) => g.label))];
                      const brands = rows.some((r) => matchBrandGroups(r.id, brandMatchers) === OTHER_BRAND)
                        ? [...labels, OTHER_BRAND]
                        : labels;
                      return brands.map((label) => {
                        const active = brandFilter.has(label);
                        return (
                          <Button
                            key={label}
                            variant="ghost"
                            size="sm"
                            className={cn("h-8 rounded-full px-3 text-xs", active && "bg-[var(--color-surface-hover)] text-[var(--color-foreground)]")}
                            onClick={() => toggleBrand(label)}
                            aria-pressed={active}
                          >
                            {label}
                          </Button>
                        );
                      });
                    })()}
                  </div>
                ) : null}

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
                          <TableHead>协议</TableHead>
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
                            <TableCell>
                              <div className="font-mono text-sm">{row.id}</div>
                              {row.supports_vision ? <Badge variant="default" className="mt-1">识图</Badge> : null}
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                {(row.supported_protocols ?? []).map((p) => (
                                  <Badge key={p} variant="outline" className="text-[10px]">{shortProtocolLabel(p)}</Badge>
                                ))}
                              </div>
                            </TableCell>
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
                              {row.supports_vision ? (
                                <span className="inline-flex items-center rounded-md border border-[var(--color-accent)]/20 bg-[var(--color-accent-muted)] px-2 py-0.5 text-xs font-medium text-[var(--color-accent)]">
                                  识图
                                </span>
                              ) : null}
                              {(row.supported_protocols ?? []).map((p) => (
                                <span key={p} className="inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-2 py-0.5 text-[10px] text-[var(--color-foreground-secondary)]">
                                  {shortProtocolLabel(p)}
                                </span>
                              ))}
                            </div>
                            {(() => {
                              const metrics = metricsMap[row.id];
                              if (!metrics) return null;
                              const hasMetrics = metrics.hourly.some((b) => b.success_rate > 0);
                              if (!hasMetrics) return null;
                              const latencyLabel = metrics.avg_latency_ms >= 1000
                                ? `${(metrics.avg_latency_ms / 1000).toFixed(1)}s`
                                : `${metrics.avg_latency_ms}ms`;
                              const tpsLabel = `${metrics.avg_output_tps}tps`;
                              const hourCounts = metrics.hourly.reduce<Record<number, number>>((acc, b) => {
                                acc[b.hours] = (acc[b.hours] ?? 0) + 1;
                                return acc;
                              }, {});
                              const hourIndex: Record<number, number> = {};
                              return (
                                <div className="flex items-center gap-2 text-xs font-mono text-[var(--color-foreground-muted)]">
                                  <span>{latencyLabel}</span>
                                  <span>{tpsLabel}</span>
                                  <div className="flex items-center gap-0.5">
                                    {metrics.hourly.map((bucket, idx) => {
                                      const rate = bucket.success_rate;
                                      const count = bucket.request_count;
                                      const color =
                                        count === 0
                                          ? "bg-gray-300 dark:bg-gray-600"
                                          : rate >= 90
                                            ? "bg-emerald-500"
                                            : rate >= 70
                                              ? "bg-amber-500"
                                              : "bg-red-500";
                                      const suffix = (hourCounts[bucket.hours] ?? 0) > 1
                                        ? `(${(hourIndex[bucket.hours] = (hourIndex[bucket.hours] ?? 0) + 1)})`
                                        : "";
                                      const label = count === 0
                                        ? `近${bucket.hours}h${suffix}: 无数据`
                                        : `近${bucket.hours}h${suffix}: ${rate}% (${count}次)`;
                                      return (
                                        <Tooltip key={idx}>
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
                                <div key={`${ch.channel_id}-${ch.real_model}`} className="flex items-center justify-between text-xs">
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="text-[var(--color-foreground-secondary)] truncate max-w-[180px] cursor-default">
                                        {ch.channel_name}{ch.real_model !== row.id ? ` (${ch.real_model})` : null}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="text-xs">
                                      <p>{ch.channel_name}</p>
                                      <p className="text-[var(--color-foreground-muted)]">{ch.real_model}</p>
                                    </TooltipContent>
                                  </Tooltip>
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

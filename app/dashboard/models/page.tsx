"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Copy, LayoutGrid, List, Search } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { SectionTitle } from "@/components/dashboard/section-title";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/shared/utils";
import { getApiMessage } from "@/lib/shared/api-message";
import { authedFetch, ensureLoggedIn, getCachedProfile } from "@/lib/auth/client-auth";
import { shortProtocolLabel, type Protocol } from "@/app/dashboard/channels/channel-model";
import { ScheduleSourceTag } from "@/app/dashboard/channels/schedule-source-tag";
import { describeAggregatedScheduleSource, describeScheduleSource } from "@/lib/shared/multiplier-source";
import { describeChannelSchedules } from "@/lib/shared/multiplier-schedule-text";

type ScheduleWindow = {
  days: number[];
  start: string;
  end: string;
  token_multiplier: number | null;
  request_multiplier: number | null;
};

type ChannelMultiplier = {
  channel_id: number;
  channel_name: string;
  real_model: string;
  token_multiplier: number;
  request_multiplier: number;
  effective_token_multiplier: number;
  effective_request_multiplier: number;
  token_multiplier_from_model_schedule: boolean;
  request_multiplier_from_model_schedule: boolean;
  // 该维度是否命中分时档（不分层）。与 from_model_schedule 一起才能区分「渠道档覆盖」和「就是基础倍率」。
  token_multiplier_scheduled: boolean;
  request_multiplier_scheduled: boolean;
  weight: number;
  effective_weight: number;
  // 两层分时档原样带回（库里是 UTC），由前端按浏览器时区换算展示
  multiplier_schedules?: ScheduleWindow[];
  channel_multiplier_schedules?: ScheduleWindow[];
};

type BrandGroup = {
  label: string;
  pattern: string;
};

const OTHER_BRAND = "其他";

type ProtocolCategory = "text" | "embeddings" | "images" | "other";

const PROTOCOL_CATEGORY_OPTIONS: Array<{ value: ProtocolCategory; label: string }> = [
  { value: "text", label: "对话" },
  { value: "embeddings", label: "Embeddings" },
  { value: "images", label: "Images" },
  { value: "other", label: "Other" },
];

const SPECIAL_PROTOCOLS: Protocol[] = ["embeddings", "images", "other"];

function isSpecialProtocol(protocol: Protocol): protocol is "embeddings" | "images" | "other" {
  return SPECIAL_PROTOCOLS.includes(protocol);
}

function protocolCategoryOf(protocol: Protocol): ProtocolCategory {
  return isSpecialProtocol(protocol) ? protocol : "text";
}

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
  effective_token_multiplier_min: number;
  effective_token_multiplier_max: number;
  effective_request_multiplier_min: number;
  effective_request_multiplier_max: number;
  multiplier_schedule_applied: boolean;
  token_multiplier_from_model_schedule: boolean;
  request_multiplier_from_model_schedule: boolean;
  token_multiplier_scheduled: boolean;
  request_multiplier_scheduled: boolean;
  weight_min: number;
  weight_max: number;
  effective_weight_min: number;
  effective_weight_max: number;
  max_effective_weight: number;
  channels: ChannelMultiplier[];
};

// 一条别名此刻的倍率来源。只有一个渠道时能按这一条渠道的维度来源直说；
// 多渠道时聚合值只代表「至少一条渠道命中模型档」，措辞必须留余地，
// 否则单渠道场景会出现「请求倍率没有渠道由模型级分时档覆盖」这种像在说整体的句子。
function scheduleSourceLabel(row: ModelItem): string {
  const onlyChannel = row.channels.length === 1 ? row.channels[0] : null;
  if (onlyChannel) {
    return describeScheduleSource({
      tokenFromModelSchedule: onlyChannel.token_multiplier_from_model_schedule,
      requestFromModelSchedule: onlyChannel.request_multiplier_from_model_schedule,
      tokenScheduled: onlyChannel.token_multiplier_scheduled,
      requestScheduled: onlyChannel.request_multiplier_scheduled,
    });
  }
  return describeAggregatedScheduleSource({
    tokenFromModelSchedule: row.token_multiplier_from_model_schedule,
    requestFromModelSchedule: row.request_multiplier_from_model_schedule,
  });
}

// 各渠道的分时档清单：时间按浏览者时区换算，并标出此刻命中的那一档
function scheduleWindowLines(row: ModelItem, now: Date): string[] {
  return describeChannelSchedules(
    row.channels.map((channel) => ({
      channelName: channel.channel_name,
      modelSchedules: channel.multiplier_schedules,
      channelSchedules: channel.channel_multiplier_schedules,
    })),
    undefined,
    now,
  );
}

// 悬浮说明的第一行：两个视图（列表 / 卡片）必须一样，
// 否则卡片上写着生效值、提示里只写基础倍率，看起来像两边对不上
function multiplierTooltipHead(row: ModelItem, type: "token" | "request"): string {
  const baseMin = type === "token" ? row.token_multiplier_min : row.request_multiplier_min;
  const baseMax = type === "token" ? row.token_multiplier_max : row.request_multiplier_max;
  const baseLabel = baseMin !== baseMax ? `${baseMin}x ~ ${baseMax}x` : `${baseMin}x`;
  const scheduled = type === "token" ? row.token_multiplier_scheduled : row.request_multiplier_scheduled;
  return scheduled
    ? `当前时段生效倍率，基础倍率 ${baseLabel}；${scheduleSourceLabel(row)}`
    : `基础倍率 ${baseLabel}`;
}

type SortField = "id" | "effective_token_multiplier" | "effective_request_multiplier" | "weight" | "effective_weight";
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
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const [protocolFilter, setProtocolFilter] = useState<Set<ProtocolCategory>>(() => new Set());
  const [brandGroups, setBrandGroups] = useState<BrandGroup[]>([]);
  const [brandFilter, setBrandFilter] = useState<Set<string>>(() => new Set());
  const { toast } = useToast();

  function toggleProtocol(value: ProtocolCategory) {
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
    if (saved === "card" || saved === "list") {
      queueMicrotask(() => setView(saved as "card" | "list"));
    }
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
        const modelCategories = new Set((r.supported_protocols ?? []).map(protocolCategoryOf));
        let protocolHit = false;
        for (const cat of protocolFilter) {
          if (modelCategories.has(cat)) { protocolHit = true; break; }
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
      switch (sortField) {
        case "id":
          cmp = a.id.localeCompare(b.id);
          break;
        case "effective_token_multiplier":
          cmp = a.effective_token_multiplier_min - b.effective_token_multiplier_min;
          break;
        case "effective_request_multiplier":
          cmp = a.effective_request_multiplier_min - b.effective_request_multiplier_min;
          break;
        case "weight":
          cmp = a.weight_max - b.weight_max;
          break;
        case "effective_weight":
          cmp = a.effective_weight_max - b.effective_weight_max;
          break;
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [filtered, sortField, sortOrder]);

  // 每行的档位清单只算一次：Token 与请求两列、卡片与列表共用同一份，
  // 避免每次重渲染按渠道×层×档位重复做时区换算。
  // 结果含「此刻命中」标注，所以要按分钟失效，否则页面停着不动标注会一直停在加载那一刻
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const scheduleLinesById = useMemo(() => {
    const at = new Date(minuteBucket * 60_000);
    const map = new Map<string, string[]>();
    for (const row of rows) map.set(row.id, scheduleWindowLines(row, at));
    return map;
  }, [rows, minuteBucket]);

  function renderMultiplier(row: ModelItem, type: "token" | "request") {
    const effectiveMin = type === "token" ? row.effective_token_multiplier_min : row.effective_request_multiplier_min;
    const effectiveMax = type === "token" ? row.effective_token_multiplier_max : row.effective_request_multiplier_max;
    const hasRange = effectiveMin !== effectiveMax;
    const hasMultipleChannels = row.channels.length > 1;
    // 按维度判：只有 Token 命中分时档时，请求列不该跟着标「分时」。
    const scheduled = type === "token" ? row.token_multiplier_scheduled : row.request_multiplier_scheduled;
    const emphasized = effectiveMin !== 1 || effectiveMax !== 1 || hasRange;
    const expanded = expandedIds.has(row.id);
    const label = hasRange ? `${effectiveMin}x ~ ${effectiveMax}x` : `${effectiveMin}x`;
    const tone = emphasized
      ? "text-[var(--color-accent)] font-semibold"
      : "text-[var(--color-foreground-muted)]";

    const content = (
      <>
        <span className={cn("font-mono text-sm", tone)}>{label}</span>
        {scheduled ? (
          <span className="text-[10px] text-[var(--color-foreground-muted)]">分时</span>
        ) : null}
      </>
    );

    // 来源按维度判：模型档只填了 token 时，请求倍率仍是渠道档或基础倍率给的，笼统说「模型/渠道」会指错。
    const tooltipLines = [multiplierTooltipHead(row, type), ...(scheduleLinesById.get(row.id) ?? [])];

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {hasMultipleChannels ? (
            <button
              type="button"
              onClick={() => toggleExpand(row.id)}
              aria-expanded={expanded}
              aria-controls={`expand-${row.id}`}
              aria-label={expanded ? "收起渠道信息" : "展开渠道信息"}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-[var(--color-surface-hover)]"
            >
              {content}
              <ChevronDown className={cn("h-3.5 w-3.5 text-[var(--color-foreground-muted)] transition-transform", expanded && "rotate-180")} />
            </button>
          ) : (
            <span tabIndex={0} className="inline-flex cursor-default items-center gap-1 px-2 py-1">{content}</span>
          )}
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-80 whitespace-pre-line text-xs">
          {tooltipLines.join("\n")}
        </TooltipContent>
      </Tooltip>
    );
  }

  function renderWeight(row: ModelItem, type: "weight" | "effective_weight") {
    const min = type === "weight" ? row.weight_min : row.effective_weight_min;
    const max = type === "weight" ? row.weight_max : row.effective_weight_max;
    const hasRange = min !== max;
    const hasMultipleChannels = row.channels.length > 1;
    const expanded = expandedIds.has(row.id);

    if (hasMultipleChannels) {
      return (
        <button
          type="button"
          onClick={() => toggleExpand(row.id)}
          aria-expanded={expanded}
          aria-controls={`expand-${row.id}`}
          aria-label={expanded ? "收起渠道信息" : "展开渠道信息"}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 font-mono text-sm transition-colors hover:bg-[var(--color-surface-hover)]"
        >
          <span className="text-[var(--color-foreground-muted)]">
            {hasRange ? `${min}x ~ ${max}x` : `${min}x`}
          </span>
          <ChevronDown className={cn("h-3.5 w-3.5 text-[var(--color-foreground-muted)] transition-transform", expanded && "rotate-180")} />
        </button>
      );
    }

    return (
      <span className="font-mono text-sm text-[var(--color-foreground-muted)]">{min}x</span>
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
                  <FilterPill active={protocolFilter.size === 0} onClick={clearProtocolFilter}>
                    全部协议
                  </FilterPill>
                  {PROTOCOL_CATEGORY_OPTIONS.map((opt) => (
                    <FilterPill key={opt.value} active={protocolFilter.has(opt.value)} onClick={() => toggleProtocol(opt.value)}>
                      {opt.label}
                    </FilterPill>
                  ))}
                </div>

                {brandMatchers.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1">
                    <FilterPill active={brandFilter.size === 0} onClick={clearBrandFilter}>
                      全部品牌
                    </FilterPill>
                    {(() => {
                      const labels = [...new Set(brandGroups.map((g) => g.label))].filter((l) => l !== OTHER_BRAND);
                      const present = new Set(rows.map((r) => matchBrandGroups(r.id, brandMatchers)));
                      return labels
                        .filter((label) => present.has(label))
                        .concat(present.has(OTHER_BRAND) ? [OTHER_BRAND] : [])
                        .map((label) => (
                          <FilterPill key={label} active={brandFilter.has(label)} onClick={() => toggleBrand(label)}>
                            {label}
                          </FilterPill>
                        ));
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
                            field="effective_token_multiplier"
                            currentField={sortField}
                            order={sortOrder}
                            onClick={() => handleSort("effective_token_multiplier")}
                          />
                          <SortButton
                            label="请求倍率"
                            field="effective_request_multiplier"
                            currentField={sortField}
                            order={sortOrder}
                            onClick={() => handleSort("effective_request_multiplier")}
                          />
                          <SortButton
                            label="权重"
                            field="weight"
                            currentField={sortField}
                            order={sortOrder}
                            onClick={() => handleSort("weight")}
                          />
                          <SortButton
                            label="实际权重"
                            field="effective_weight"
                            currentField={sortField}
                            order={sortOrder}
                            onClick={() => handleSort("effective_weight")}
                          />
                          <TableHead className="w-16" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sorted.map((row) => {
                          const hasMultipleChannels = row.channels.length > 1;
                          const expanded = expandedIds.has(row.id);
                          return (
                            <Fragment key={row.id}>
                              <TableRow>
                                <TableCell>
                                  <div className="font-mono text-sm">{row.id}</div>
                                  {row.supports_vision ? <Badge variant="default" className="mt-1">识图</Badge> : null}
                                </TableCell>
                                <TableCell>
                                  <div className="flex flex-wrap gap-1">
                                    {(row.supported_protocols ?? []).filter((p) => SPECIAL_PROTOCOLS.includes(p)).map((p) => (
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
                                <TableCell className="text-center">
                                  {renderWeight(row, "weight")}
                                </TableCell>
                                <TableCell className="text-center">
                                  {renderWeight(row, "effective_weight")}
                                </TableCell>
                                <TableCell>
                                  <Button size="sm" variant="ghost" onClick={() => copyText(row.id)}>
                                    <Copy className="h-3.5 w-3.5" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                              {expanded && hasMultipleChannels ? (
                                row.channels.map((ch, chIdx) => (
                                  <TableRow
                                    key={`${ch.channel_id}-${ch.real_model}`}
                                    id={chIdx === 0 ? `expand-${row.id}` : undefined}
                                    className="bg-[var(--color-surface-hover)]/40 hover:bg-[var(--color-surface-hover)]/40"
                                  >
                                    <TableCell className="pl-10 text-sm text-[var(--color-foreground-secondary)]">{ch.channel_name}</TableCell>
                                    <TableCell>
                                      {ch.real_model !== row.id ? (
                                        <span className="text-xs text-[var(--color-foreground-muted)]">{ch.real_model}</span>
                                      ) : null}
                                    </TableCell>
                                    <TableCell className="text-center font-mono text-sm">
                                      {ch.effective_token_multiplier}x
                                      <ScheduleSourceTag
                                        fromModel={ch.token_multiplier_from_model_schedule}
                                        scheduled={ch.token_multiplier_scheduled}
                                      />
                                    </TableCell>
                                    <TableCell className="text-center font-mono text-sm">
                                      {ch.effective_request_multiplier}x
                                      <ScheduleSourceTag
                                        fromModel={ch.request_multiplier_from_model_schedule}
                                        scheduled={ch.request_multiplier_scheduled}
                                      />
                                    </TableCell>
                                    <TableCell className="text-center font-mono text-sm">{ch.weight}x</TableCell>
                                    <TableCell className="text-center font-mono text-sm">{ch.effective_weight}x</TableCell>
                                    <TableCell />
                                  </TableRow>
                                ))
                              ) : null}
                            </Fragment>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {sorted.map((row) => {
                      const hasTokenRange = row.effective_token_multiplier_min !== row.effective_token_multiplier_max;
                      const hasRequestRange = row.effective_request_multiplier_min !== row.effective_request_multiplier_max;
                      const hasMultipleChannels = row.channels.length > 1;
                      const scheduled = row.multiplier_schedule_applied;

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
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className={cn(
                                    "inline-flex cursor-default items-center rounded-md border px-2 py-0.5 text-xs font-mono",
                                    row.effective_token_multiplier_min !== 1 || row.effective_token_multiplier_max !== 1
                                      ? "border-[var(--color-accent)]/20 bg-[var(--color-accent-muted)] text-[var(--color-accent)]"
                                      : "border-[var(--color-border)] bg-[var(--color-surface-hover)] text-[var(--color-foreground-secondary)]"
                                  )}>
                                    Token {hasTokenRange
                                      ? row.effective_token_multiplier_min + "x~" + row.effective_token_multiplier_max + "x"
                                      : row.effective_token_multiplier_min + "x"}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-80 whitespace-pre-line text-xs">
                                  {[multiplierTooltipHead(row, "token"), ...(scheduleLinesById.get(row.id) ?? [])].join("\n")}
                                </TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className={cn(
                                    "inline-flex cursor-default items-center rounded-md border px-2 py-0.5 text-xs font-mono",
                                    row.effective_request_multiplier_min !== 1 || row.effective_request_multiplier_max !== 1
                                      ? "border-[var(--color-accent)]/20 bg-[var(--color-accent-muted)] text-[var(--color-accent)]"
                                      : "border-[var(--color-border)] bg-[var(--color-surface-hover)] text-[var(--color-foreground-secondary)]"
                                  )}>
                                    请求 {hasRequestRange
                                      ? row.effective_request_multiplier_min + "x~" + row.effective_request_multiplier_max + "x"
                                      : row.effective_request_multiplier_min + "x"}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-80 whitespace-pre-line text-xs">
                                  {[multiplierTooltipHead(row, "request"), ...(scheduleLinesById.get(row.id) ?? [])].join("\n")}
                                </TooltipContent>
                              </Tooltip>
                              {scheduled ? (
                                <span
                                  className="inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-foreground-secondary)]"
                                  title={[
                                    `当前时段生效倍率已按分时档覆盖：${scheduleSourceLabel(row)}`,
                                    ...(scheduleLinesById.get(row.id) ?? []),
                                  ].join("\n")}
                                >
                                  分时
                                </span>
                              ) : null}
                              {row.supports_vision ? (
                                <span className="inline-flex items-center rounded-md border border-[var(--color-accent)]/20 bg-[var(--color-accent-muted)] px-2 py-0.5 text-xs font-medium text-[var(--color-accent)]">
                                  识图
                                </span>
                              ) : null}
                              {(row.supported_protocols ?? []).filter((p) => SPECIAL_PROTOCOLS.includes(p)).map((p) => (
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
                                    <span className={cn("font-mono", ch.effective_token_multiplier !== 1 && "text-[var(--color-accent)] font-semibold")}>
                                      T{ch.effective_token_multiplier}x
                                      <ScheduleSourceTag
                                        fromModel={ch.token_multiplier_from_model_schedule}
                                        scheduled={ch.token_multiplier_scheduled}
                                      />
                                    </span>
                                    <span className={cn("font-mono", ch.effective_request_multiplier !== 1 && "text-[var(--color-accent)] font-semibold")}>
                                      R{ch.effective_request_multiplier}x
                                      <ScheduleSourceTag
                                        fromModel={ch.request_multiplier_from_model_schedule}
                                        scheduled={ch.request_multiplier_scheduled}
                                      />
                                    </span>
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

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors",
        active
          ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
          : "border-[var(--color-border)] bg-transparent text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)]",
      )}
    >
      {children}
    </button>
  );
}

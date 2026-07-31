"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/shared/utils";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, Copy, EyeOff, LayoutGrid, List, Plus, Search, Table2 } from "lucide-react";
import { parseSupportedProtocols, shortProtocolLabel } from "./channel-model";
import type { ModelRow, ModelWithChannel } from "./channel-model";
import { ModelCard } from "./model-card";
import { ModelListRow } from "./model-list-row";

type ChannelGroup = {
  channelId: number;
  channelName: string;
  models: ModelWithChannel[];
};

type FlatSortField =
  | "alias"
  | "real_model"
  | "channel_name"
  | "protocols"
  | "status"
  | "visibility"
  | "copilot"
  | "weight"
  | "effective_weight"
  | "multiplier"
  | "max_concurrency";
type FlatSortOrder = "asc" | "desc";

function protocolLabels(model: ModelWithChannel): string {
  return parseSupportedProtocols(model.supported_protocols).map(shortProtocolLabel).join(",");
}

function effectiveWeight(model: ModelWithChannel): number {
  return Math.max(1, model.weight) * Math.max(1, model.channel_weight);
}

function compareModels(a: ModelWithChannel, b: ModelWithChannel, field: FlatSortField): number {
  switch (field) {
    case "alias":
      return a.alias.localeCompare(b.alias);
    case "real_model":
      return a.real_model.localeCompare(b.real_model);
    case "channel_name":
      return a.channel_name.localeCompare(b.channel_name);
    case "protocols":
      return protocolLabels(a).localeCompare(protocolLabels(b));
    case "status":
      return (a.enabled !== 0 ? 1 : 0) - (b.enabled !== 0 ? 1 : 0);
    case "visibility":
      return (a.is_public !== 0 ? 1 : 0) - (b.is_public !== 0 ? 1 : 0);
    case "copilot":
      return (a.copilot_compatibility !== 0 ? 1 : 0) - (b.copilot_compatibility !== 0 ? 1 : 0);
    case "weight":
      return a.weight - b.weight;
    case "effective_weight":
      return effectiveWeight(a) - effectiveWeight(b);
    case "multiplier":
      return ((a.token_multiplier ?? 1) - (b.token_multiplier ?? 1)) || ((a.request_multiplier ?? 1) - (b.request_multiplier ?? 1));
    case "max_concurrency":
      return a.max_concurrency - b.max_concurrency;
  }
}

export function ModelTable({
  models,
  channelsCount,
  testingModelId,
  onCreate,
  onAddForChannel,
  onTest,
  onEdit,
  onToggle,
  onRemove,
}: {
  models: ModelWithChannel[];
  channelsCount: number;
  testingModelId: number | null;
  onCreate: () => void;
  onAddForChannel: (channelId: number) => void;
  onTest: (row: ModelRow) => void;
  onEdit: (row: ModelRow) => void;
  onToggle: (row: ModelRow) => void;
  onRemove: (id: number) => void;
}) {
  const [search, setSearch] = useState("");

  function computeDefaultCollapsed(list: ModelWithChannel[]): Set<number> {
    const byChannel = new Map<number, ModelWithChannel[]>();
    for (const model of list) {
      const arr = byChannel.get(model.channel_id);
      if (arr) arr.push(model);
      else byChannel.set(model.channel_id, [model]);
    }
    const initial = new Set<number>();
    for (const [channelId, channelModels] of byChannel) {
      const channelDisabled = channelModels[0]?.channel_enabled === 0;
      const hasEnabledModel = channelModels.some((m) => m.enabled !== 0);
      if (channelDisabled || !hasEnabledModel) initial.add(channelId);
    }
    return initial;
  }

  const [collapsed, setCollapsed] = useState<Set<number>>(() => computeDefaultCollapsed(models));
  const [manualToggled, setManualToggled] = useState<Set<number>>(new Set());

  const modelSignature = useMemo(
    () => models.map((m) => `${m.channel_id}:${m.channel_enabled}:${m.enabled}`).join("|"),
    [models],
  );

  useEffect(() => {
    const defaults = computeDefaultCollapsed(models);
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const model of models) {
        const id = model.channel_id;
        if (manualToggled.has(id)) continue;
        if (defaults.has(id)) next.add(id);
        else next.delete(id);
      }
      // 仅依赖 modelSignature：models/manualToggled 通过闭包取本次 render 最新值，
      // 避免每次渲染都重算，同时保证数据（渠道禁用/模型启用状态）变化后重算默认折叠
      if (next.size === prev.size && [...next].every((v) => prev.has(v))) return prev;
      return next;
    });
  }, [modelSignature]); // eslint-disable-line react-hooks/exhaustive-deps
  const [view, setView] = useState<"card" | "list" | "flat">(() => {
    if (typeof window === "undefined") return "card";
    const saved = localStorage.getItem("modelView");
    return saved === "card" || saved === "list" || saved === "flat" ? saved : "card";
  });

  function changeView(v: "card" | "list" | "flat") {
    setView(v);
    localStorage.setItem("modelView", v);
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.alias.toLowerCase().includes(q) ||
        m.real_model.toLowerCase().includes(q),
    );
  }, [models, search]);

  const groups = useMemo<ChannelGroup[]>(() => {
    const map = new Map<number, ChannelGroup>();
    for (const model of filtered) {
      let group = map.get(model.channel_id);
      if (!group) {
        group = { channelId: model.channel_id, channelName: model.channel_name, models: [] };
        map.set(model.channel_id, group);
      }
      group.models.push(model);
    }
    return Array.from(map.values());
  }, [filtered]);

  const [sortField, setSortField] = useState<FlatSortField>("alias");
  const [sortOrder, setSortOrder] = useState<FlatSortOrder>("asc");
  const [hideDisabled, setHideDisabled] = useState(false);

  function handleSort(field: FlatSortField) {
    if (sortField === field) setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    else {
      setSortField(field);
      setSortOrder("asc");
    }
  }

  const sorted = useMemo(() => {
    const list = filtered.filter((m) => !hideDisabled || m.enabled !== 0);
    list.sort((a, b) => {
      const cmp = compareModels(a, b, sortField);
      return sortOrder === "asc" ? cmp : -cmp;
    });
    return list;
  }, [filtered, sortField, sortOrder, hideDisabled]);

  function toggleCollapse(channelId: number) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
    setManualToggled((prev) => {
      const next = new Set(prev);
      next.add(channelId);
      return next;
    });
  }

  const { toast } = useToast();

  function copyChannelModels(group: ChannelGroup) {
    const text = group.models.map((model) => model.alias).join(",");
    if (!text) {
      toast({ variant: "info", description: "该渠道下没有可复制的模型。" });
      return;
    }
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      toast({ variant: "error", description: "当前环境不支持剪贴板复制（需 HTTPS 或 localhost）。" });
      return;
    }
    void clipboard.writeText(text).then(
      () => toast({ variant: "success", description: `已复制 ${group.models.length} 个模型到剪贴板。` }),
      () => toast({ variant: "error", description: "复制失败，请检查浏览器剪贴板权限。" }),
    );
  }


  if (models.length === 0) {
    return (
      <EmptyState
        title="暂无模型映射"
        description="在渠道接入完成后，为客户端配置 alias 到真实模型的映射关系。"
        action={<Button disabled={channelsCount === 0} onClick={onCreate}>新增模型映射</Button>}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-foreground-muted)]" />
          <Input
            className="pl-9"
            placeholder="搜索别名 / 真实模型"
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn("h-8 w-8 rounded-sm", view === "list" && "bg-[var(--color-surface-hover)] text-[var(--color-foreground)]")}
                onClick={() => changeView("list")}
                aria-label="分组列表视图"
                aria-pressed={view === "list"}
              >
                <List className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>分组列表视图</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn("h-8 w-8 rounded-sm", view === "flat" && "bg-[var(--color-surface-hover)] text-[var(--color-foreground)]")}
                onClick={() => changeView("flat")}
                aria-label="平铺表格视图"
                aria-pressed={view === "flat"}
              >
                <Table2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>平铺表格（不分组，点击表头排序）</TooltipContent>
          </Tooltip>
        </div>
        {view === "flat" ? (
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-8 gap-1.5 rounded-sm px-2.5 text-xs", hideDisabled && "bg-[var(--color-surface-hover)] text-[var(--color-foreground)]")}
            onClick={() => setHideDisabled((v) => !v)}
            aria-pressed={hideDisabled}
          >
            <EyeOff className="h-4 w-4" />
            隐藏禁用模型
          </Button>
        ) : null}
        <Button disabled={channelsCount === 0} onClick={onCreate}>新增模型映射</Button>
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--color-foreground-muted)]">未找到匹配的模型。</p>
      ) : view === "list" ? (
        <div className="space-y-3">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.channelId);
            return (
              <div key={group.channelId} className="rounded-xl border border-[var(--color-border)]">
                <div className="flex items-center justify-between gap-2 px-4 py-3 transition-colors hover:bg-[var(--color-surface-hover)]">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => toggleCollapse(group.channelId)}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-foreground-muted)]" />
                    ) : (
                      <ChevronDown className="h-4 w-4 shrink-0 text-[var(--color-foreground-muted)]" />
                    )}
                    <span className="truncate text-sm font-medium text-[var(--color-foreground)]">{group.channelName}</span>
                    <span className="shrink-0 text-xs text-[var(--color-foreground-muted)]">{group.models.length} 个模型</span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    aria-label={`复制渠道 ${group.channelName} 下全部模型`}
                    onClick={() => copyChannelModels(group)}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    aria-label={`为渠道 ${group.channelName} 添加模型`}
                    onClick={() => onAddForChannel(group.channelId)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {!isCollapsed && (
                  <div className="border-t border-[var(--color-border)]">
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-12">序号</TableHead>
                            <TableHead>别名</TableHead>
                            <TableHead>真实模型</TableHead>
                            <TableHead>所属渠道</TableHead>
                            <TableHead>协议</TableHead>
                            <TableHead>状态</TableHead>
                            <TableHead>可见性</TableHead>
                            <TableHead>Copilot</TableHead>
                            <TableHead>权重</TableHead>
                            <TableHead>实际权重</TableHead>
                            <TableHead>倍率</TableHead>
                            <TableHead>最大并发</TableHead>
                            <TableHead>开关</TableHead>
                            <TableHead className="sticky right-0 z-20 w-36 bg-[var(--color-surface-solid)] shadow-[-8px_0_12px_-8px_rgba(0,0,0,0.18)]">操作</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {group.models.map((model, idx) => (
                            <ModelListRow
                              key={model.id}
                              model={model}
                              index={idx}
                              testing={testingModelId === model.id}
                              onTest={() => onTest(model)}
                              onEdit={() => onEdit(model)}
                              onToggle={() => onToggle(model)}
                              onRemove={() => onRemove(model.id)}
                            />
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : view === "flat" ? (
        sorted.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--color-foreground-muted)]">没有启用的模型（可关闭「隐藏禁用模型」查看）。</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">序号</TableHead>
                  <SortableHead label="别名" field="alias" currentField={sortField} order={sortOrder} onSort={handleSort} />
                  <SortableHead label="真实模型" field="real_model" currentField={sortField} order={sortOrder} onSort={handleSort} />
                  <SortableHead label="所属渠道" field="channel_name" currentField={sortField} order={sortOrder} onSort={handleSort} />
                  <SortableHead label="协议" field="protocols" currentField={sortField} order={sortOrder} onSort={handleSort} />
                  <SortableHead label="状态" field="status" currentField={sortField} order={sortOrder} onSort={handleSort} />
                  <SortableHead label="可见性" field="visibility" currentField={sortField} order={sortOrder} onSort={handleSort} />
                  <SortableHead label="Copilot" field="copilot" currentField={sortField} order={sortOrder} onSort={handleSort} />
                  <SortableHead label="权重" field="weight" currentField={sortField} order={sortOrder} onSort={handleSort} />
                  <SortableHead label="实际权重" field="effective_weight" currentField={sortField} order={sortOrder} onSort={handleSort} />
                  <SortableHead label="倍率" field="multiplier" currentField={sortField} order={sortOrder} onSort={handleSort} />
                  <SortableHead label="最大并发" field="max_concurrency" currentField={sortField} order={sortOrder} onSort={handleSort} />
                  <TableHead>开关</TableHead>
                  <TableHead className="sticky right-0 z-20 w-36 bg-[var(--color-surface-solid)] shadow-[-8px_0_12px_-8px_rgba(0,0,0,0.18)]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((model, idx) => (
                  <ModelListRow
                    key={model.id}
                    model={model}
                    index={idx}
                    testing={testingModelId === model.id}
                    onTest={() => onTest(model)}
                    onEdit={() => onEdit(model)}
                    onToggle={() => onToggle(model)}
                    onRemove={() => onRemove(model.id)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )
      ) : (
        <div className="space-y-3">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.channelId);
            return (
              <div key={group.channelId} className="rounded-xl border border-[var(--color-border)]">
                <div className="flex items-center justify-between gap-2 px-4 py-3 transition-colors hover:bg-[var(--color-surface-hover)]">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => toggleCollapse(group.channelId)}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-foreground-muted)]" />
                    ) : (
                      <ChevronDown className="h-4 w-4 shrink-0 text-[var(--color-foreground-muted)]" />
                    )}
                    <span className="truncate text-sm font-medium text-[var(--color-foreground)]">{group.channelName}</span>
                    <span className="shrink-0 text-xs text-[var(--color-foreground-muted)]">{group.models.length} 个模型</span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    aria-label={`复制渠道 ${group.channelName} 下全部模型`}
                    onClick={() => copyChannelModels(group)}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    aria-label={`为渠道 ${group.channelName} 添加模型`}
                    onClick={() => onAddForChannel(group.channelId)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {!isCollapsed && (
                  <div className="grid gap-3 border-t border-[var(--color-border)] p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {group.models.map((model) => (
                      <ModelCard
                        key={model.id}
                        model={model}
                        testing={testingModelId === model.id}
                        onTest={() => onTest(model)}
                        onEdit={() => onEdit(model)}
                        onToggle={() => onToggle(model)}
                        onRemove={() => onRemove(model.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SortableHead({
  label,
  field,
  currentField,
  order,
  onSort,
}: {
  label: string;
  field: FlatSortField;
  currentField: FlatSortField;
  order: FlatSortOrder;
  onSort: (field: FlatSortField) => void;
}) {
  const active = field === currentField;
  return (
    <TableHead
      aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}
      tabIndex={0}
      className="cursor-pointer select-none whitespace-nowrap"
      onClick={() => onSort(field)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSort(field);
        }
      }}
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

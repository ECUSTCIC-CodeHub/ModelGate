"use client";

import { useMemo, useState } from "react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import type { ModelRow, ModelWithChannel } from "./channel-model";
import { ModelCard } from "./model-card";

type ChannelGroup = {
  channelId: number;
  channelName: string;
  models: ModelWithChannel[];
};

export function ModelTable({
  models,
  channelsCount,
  testingModelId,
  onCreate,
  onTest,
  onEdit,
  onToggle,
  onRemove,
}: {
  models: ModelWithChannel[];
  channelsCount: number;
  testingModelId: number | null;
  onCreate: () => void;
  onTest: (row: ModelRow) => void;
  onEdit: (row: ModelRow) => void;
  onToggle: (row: ModelRow) => void;
  onRemove: (id: number) => void;
}) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

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

  function toggleCollapse(channelId: number) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
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
        <Button disabled={channelsCount === 0} onClick={onCreate}>新增模型映射</Button>
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--color-foreground-muted)]">未找到匹配的模型。</p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.channelId);
            return (
              <div key={group.channelId} className="rounded-xl border border-[var(--color-border)]">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
                  onClick={() => toggleCollapse(group.channelId)}
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-4 w-4 text-[var(--color-foreground-muted)]" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-[var(--color-foreground-muted)]" />
                  )}
                  <span className="text-sm font-medium text-[var(--color-foreground)]">{group.channelName}</span>
                  <span className="text-xs text-[var(--color-foreground-muted)]">{group.models.length} 个模型</span>
                </button>
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

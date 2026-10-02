"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TriangleAlert } from "lucide-react";
import type { Protocol, StaleModelsResult } from "./channel-model";

export function StaleModelDialog({
  open,
  channelName,
  protocols,
  result,
  selectedIds,
  deleting,
  onOpenChange,
  onToggleModel,
  onSelectModels,
  onConfirm,
}: {
  open: boolean;
  channelName: string;
  protocols: Protocol[];
  result: StaleModelsResult | null;
  selectedIds: Set<number>;
  deleting: boolean;
  onOpenChange: (open: boolean) => void;
  onToggleModel: (id: number, selected: boolean) => void;
  onSelectModels: (ids: number[], selected: boolean) => void;
  onConfirm: () => void;
}) {
  const [query, setQuery] = useState("");

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const list = result?.stale ?? [];
    return list.filter(
      (item) =>
        !normalizedQuery ||
        item.alias.toLowerCase().includes(normalizedQuery) ||
        item.real_model.toLowerCase().includes(normalizedQuery),
    );
  }, [result, normalizedQuery]);

  const stale = result?.stale ?? [];

  const selectedCount = stale.filter((item) => selectedIds.has(item.id)).length;
  const allLocal = (result?.local_count ?? 0) > 0 && stale.length === result?.local_count;
  const protocolWarning = protocols.includes("images") || protocols.includes("other");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl"
        onInteractOutside={(event) => {
          if (deleting) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (deleting) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>清理上游已下架的模型</DialogTitle>
          <DialogDescription>
            上游 /models 中已不存在的真实模型将被软删除，删除后客户端无法再通过对应别名访问。
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="flex min-h-0 flex-col gap-3">
            <div className="space-y-1 text-sm">
              <p className="text-[var(--color-foreground)]">渠道：{channelName}</p>
              {allLocal ? (
                <p className="font-semibold text-[var(--color-destructive)]">
                  该渠道全部 {result.local_count} 个模型都将被删除
                </p>
              ) : (
                <p className="text-[var(--color-foreground-muted)]">
                  上游返回 {result.upstream_count} 个 · 本地 {result.local_count} 个 · 待删除 {stale.length} 个 · 保留 {result.kept} 个
                </p>
              )}
              {result.skipped_wildcard > 0 ? (
                <p className="text-[var(--color-foreground-muted)]">已跳过兜底模型 {result.skipped_wildcard} 个</p>
              ) : null}
            </div>

            {protocolWarning ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>该渠道勾选了 Images / Other 协议，上游 /models 可能不完整，请确认下方勾选项</span>
              </div>
            ) : null}

            <Input
              placeholder="搜索别名 / 真实模型"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-[var(--color-foreground-muted)]">已选择 {selectedCount} 个模型。</p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => onSelectModels(filtered.map((item) => item.id), true)}>
                  全选当前筛选
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => onSelectModels(filtered.map((item) => item.id), false)}>
                  清空当前筛选
                </Button>
              </div>
            </div>

            <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-[var(--color-border)]">
              {filtered.length > 0 ? (
                filtered.map((item) => (
                  <label
                    key={item.id}
                    className="flex cursor-pointer items-center justify-between gap-3 border-b border-[var(--color-border)] px-3 py-2 last:border-b-0 hover:bg-[var(--color-surface-hover)]"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="truncate font-mono text-sm text-[var(--color-foreground)]">{item.real_model}</p>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-foreground-muted)]">
                        <span className="truncate">别名 {item.alias}</span>
                        <Badge variant={item.enabled ? "default" : "secondary"}>{item.enabled ? "启用" : "禁用"}</Badge>
                        {item.alias_match ? (
                          <Badge
                            variant="outline"
                            title="别名在上游列表中存在，但真实模型名已不存在，请确认是否保留"
                          >
                            别名仍在上游
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                    <Checkbox
                      checked={selectedIds.has(item.id)}
                      onCheckedChange={(checked) => onToggleModel(item.id, checked === true)}
                    />
                  </label>
                ))
              ) : (
                <p className="px-3 py-8 text-center text-sm text-[var(--color-foreground-muted)]">没有匹配的模型。</p>
              )}
            </div>

            {result.missing_upstream.length > 0 ? (
              <p className="text-xs text-[var(--color-foreground-muted)]">
                另有 {result.missing_upstream.length} 个上游模型尚未在本地配置，可用「新增模型映射」添加
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={deleting} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" variant="destructive" disabled={deleting || selectedCount === 0} onClick={onConfirm}>
            {deleting ? "删除中…" : allLocal ? `确认删除全部 ${selectedCount} 个模型` : `确认删除 ${selectedCount} 个模型`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

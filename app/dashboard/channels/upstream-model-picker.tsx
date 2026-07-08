"use client";

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
import type { UpstreamModelOption } from "./channel-model";

export function UpstreamModelPicker({
  open,
  query,
  options,
  onOpenChange,
  onQueryChange,
  onToggleModel,
  onSelectFiltered,
  onConfirm,
}: {
  open: boolean;
  query: string;
  options: UpstreamModelOption[];
  onOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
  onToggleModel: (id: string, selected: boolean) => void;
  onSelectFiltered: (selected: boolean) => void;
  onConfirm: () => void;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = options.filter((item) => !normalizedQuery || item.id.toLowerCase().includes(normalizedQuery));
  const selectedCount = options.filter((item) => item.selected && !item.disabled).length;
  const existingCount = options.filter((item) => item.disabled).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>选择上游模型</DialogTitle>
          <DialogDescription>已存在于当前渠道的模型会默认勾选并锁定，确认后仅把新选中的模型加入草稿。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder="搜索模型 ID"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-[var(--color-foreground-muted)]">
              已选择 {selectedCount} 个新模型，{existingCount} 个已存在。
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => onSelectFiltered(true)}>全选当前筛选</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => onSelectFiltered(false)}>清空当前筛选</Button>
            </div>
          </div>
          <div className="max-h-[min(420px,45dvh)] overflow-y-auto rounded-xl border border-[var(--color-border)]">
            {filteredOptions.length > 0 ? (
              filteredOptions.map((item) => (
                <label
                  key={item.id}
                  className={`flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-3 py-2 last:border-b-0 ${item.disabled ? "cursor-not-allowed bg-[var(--color-surface-hover)] opacity-60" : "cursor-pointer"}`}
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm text-[var(--color-foreground)]">{item.id}</p>
                    {item.disabled ? <p className="text-xs text-[var(--color-foreground-muted)]">已存在于当前渠道</p> : null}
                  </div>
                  <Checkbox
                    checked={item.selected}
                    disabled={item.disabled}
                    onCheckedChange={(checked) => onToggleModel(item.id, checked === true)}
                  />
                </label>
              ))
            ) : (
              <p className="px-3 py-8 text-center text-sm text-[var(--color-foreground-muted)]">没有匹配的上游模型。</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" onClick={onConfirm}>加入草稿</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
import { shortProtocolLabel } from "./channel-model";
import { filterModelsDevProviders, protocolForModel, type ModelsDevProviderInfo } from "./models-dev-catalog";

function selectionKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

export function ModelsDevPicker({
  open,
  providers,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  providers: ModelsDevProviderInfo[];
  onOpenChange: (open: boolean) => void;
  onConfirm: (selection: Array<{ provider: ModelsDevProviderInfo; modelId: string }>) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => filterModelsDevProviders(providers, query), [providers, query]);

  function toggle(providerId: string, modelId: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = selectionKey(providerId, modelId);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function selectAllFiltered(checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const provider of filtered) {
        for (const model of provider.models) {
          const key = selectionKey(provider.providerId, model.id);
          if (checked) next.add(key);
          else next.delete(key);
        }
      }
      return next;
    });
  }

  function confirm() {
    const picked: Array<{ provider: ModelsDevProviderInfo; modelId: string }> = [];
    for (const provider of filtered.length > 0 ? filtered : providers) {
      for (const model of provider.models) {
        if (selected.has(selectionKey(provider.providerId, model.id))) {
          picked.push({ provider, modelId: model.id });
        }
      }
    }
    onConfirm(picked);
    setSelected(new Set());
    setQuery("");
  }

  const totalModels = providers.reduce((sum, provider) => sum + provider.models.length, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>从 models.dev 预填充模型</DialogTitle>
          <DialogDescription>
            共 {providers.length} 个供应商、{totalModels} 个模型。协议按供应商推导（Anthropic 用 anthropic_messages，
            OpenAI 用 chat_completions 与 responses），单个模型再按名称与输出模态细化。
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3">
          <Input placeholder="搜索供应商或模型 ID" value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-[var(--color-foreground-muted)]">已选择 {selected.size} 个模型。</p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => selectAllFiltered(true)}>全选当前筛选</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => selectAllFiltered(false)}>清空当前筛选</Button>
            </div>
          </div>
          <div className="min-h-0 max-h-[60vh] flex-1 overflow-y-auto rounded-xl border border-[var(--color-border)]">
            {filtered.length > 0 ? (
              filtered.map((provider) => (
                <div key={provider.providerId}>
                  <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-solid)] px-3 py-2">
                    <span className="text-sm font-medium text-[var(--color-foreground)]">{provider.providerId}</span>
                    <span className="text-xs text-[var(--color-foreground-muted)]">{provider.models.length} 个模型</span>
                    <div className="ml-auto flex flex-wrap gap-1">
                      {provider.protocols.map((protocol) => (
                        <Badge key={protocol} variant="outline" className="text-[10px]">
                          {shortProtocolLabel(protocol)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  {provider.models.map((model) => {
                    const protocol = protocolForModel(
                      { id: model.id, name: model.name, modalities: { output: model.outputModalities } },
                      provider.protocols,
                    );
                    return (
                      <label
                        key={model.id}
                        className="flex cursor-pointer items-center justify-between gap-3 border-b border-[var(--color-border)] px-3 py-2 last:border-b-0"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-mono text-sm text-[var(--color-foreground)]">{model.id}</p>
                          {model.name !== model.id ? (
                            <p className="truncate text-xs text-[var(--color-foreground-muted)]">{model.name}</p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge variant="secondary" className="text-[10px]">{shortProtocolLabel(protocol)}</Badge>
                          <Checkbox
                            checked={selected.has(selectionKey(provider.providerId, model.id))}
                            onCheckedChange={(checked) => toggle(provider.providerId, model.id, checked === true)}
                          />
                        </div>
                      </label>
                    );
                  })}
                </div>
              ))
            ) : (
              <p className="px-3 py-8 text-center text-sm text-[var(--color-foreground-muted)]">没有匹配的供应商或模型。</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" onClick={confirm} disabled={selected.size === 0}>加入草稿</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

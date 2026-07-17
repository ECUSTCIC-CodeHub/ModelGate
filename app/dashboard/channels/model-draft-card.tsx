"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { protocolLabel, QUOTA_MODE_OPTIONS, type ChannelModelDraft, type Protocol } from "./channel-model";

export function ModelDraftCard({
  title,
  description,
  protocols,
  drafts,
  probing,
  probeDisabled,
  onProbe,
  onAddDraft,
  onRemoveDraft,
  onUpdateDraft,
  onImportDrafts,
  showAdvancedFields = true,
}: {
  title: string;
  description: string;
  protocols: Protocol[];
  drafts: ChannelModelDraft[];
  probing: boolean;
  probeDisabled?: boolean;
  onProbe: () => void;
  onAddDraft: (protocols: Protocol[]) => void;
  onRemoveDraft: (index: number) => void;
  onUpdateDraft: (index: number, patch: Partial<ChannelModelDraft>) => void;
  onImportDrafts: (names: string[], protocols: Protocol[]) => void;
  showAdvancedFields?: boolean;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const { toast } = useToast();

  function handleImport() {
    const names = importText.split(/[\s,;，；]+/).map((name) => name.trim()).filter(Boolean);
    if (names.length === 0) {
      toast({ variant: "info", description: "没有可导入的模型名。" });
      return;
    }
    onImportDrafts(names, protocols);
    setImportText("");
  }
  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-[var(--color-foreground)]">{title}</p>
          <p className="text-xs text-[var(--color-foreground-muted)]">{description}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={probing || probeDisabled}
            onClick={onProbe}
          >
            {probing ? "拉取中…" : "从上游拉取"}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setImportOpen((prev) => !prev)}>批量导入</Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onAddDraft(protocols)}>添加模型</Button>
        </div>
      </div>
      <div className="space-y-3">
        {drafts.map((item, index) => (
          <div key={index} className="grid gap-3 rounded-lg border border-[var(--color-border)] p-3 md:grid-cols-2">
            <Input placeholder="别名" value={item.alias} onChange={(e) => onUpdateDraft(index, { alias: e.target.value })} />
            <Input placeholder="真实模型" value={item.real_model} onChange={(e) => onUpdateDraft(index, { real_model: e.target.value })} />
            {showAdvancedFields ? (
              <div className="grid gap-2 md:grid-cols-4">
                <div className="space-y-1">
                  <span className="text-xs text-[var(--color-foreground-muted)]">权重</span>
                  <Input type="number" min={1} placeholder="1" value={item.weight} onChange={(e) => onUpdateDraft(index, { weight: Number(e.target.value) || 1 })} />
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-[var(--color-foreground-muted)]">Token 倍率</span>
                  <Input type="number" min={0} step={0.1} placeholder="1" value={item.token_multiplier} onChange={(e) => onUpdateDraft(index, { token_multiplier: Number(e.target.value) || 1 })} />
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-[var(--color-foreground-muted)]">请求倍率</span>
                  <Input type="number" min={0} step={0.1} placeholder="1" value={item.request_multiplier} onChange={(e) => onUpdateDraft(index, { request_multiplier: Number(e.target.value) || 1 })} />
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-[var(--color-foreground-muted)]">最大并发</span>
                  <Input type="number" min={0} placeholder="0" value={item.max_concurrency} onChange={(e) => onUpdateDraft(index, { max_concurrency: Number(e.target.value) || 0 })} />
                </div>
              </div>
            ) : null}
            <div className="space-y-1">
              <span className="text-xs text-[var(--color-foreground-muted)]">可用协议</span>
              <div className="flex flex-wrap gap-2">
                {protocols.map((protocol) => {
                  const checked = item.supported_protocols.includes(protocol);
                  return (
                    <label key={protocol} className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) => {
                          const enabled = next === true;
                          const current = item.supported_protocols;
                          const nextProtocols = enabled
                            ? [...new Set([...current, protocol])]
                            : current.filter((p) => p !== protocol);
                          const finalProtocols = nextProtocols.length > 0 ? nextProtocols : [protocol];
                          const nextUpstream = finalProtocols.includes(item.upstream_protocol)
                            ? item.upstream_protocol
                            : finalProtocols[0];
                          onUpdateDraft(index, { supported_protocols: finalProtocols, upstream_protocol: nextUpstream });
                        }}
                      />
                      {protocolLabel(protocol)}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-xs text-[var(--color-foreground-muted)]">默认上游协议</span>
              <Select value={item.upstream_protocol} onValueChange={(value) => onUpdateDraft(index, { upstream_protocol: value as Protocol })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {item.supported_protocols.map((protocol) => (
                    <SelectItem key={protocol} value={protocol}>{protocolLabel(protocol)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 md:col-span-2">
              <div>
                <p className="text-sm font-medium text-[var(--color-foreground)]">GitHub Copilot 兼容</p>
                <p className="text-xs text-[var(--color-foreground-muted)]">规范化 tool_calls 返回，并过滤未声明的工具调用。</p>
              </div>
              <Checkbox checked={item.copilot_compatibility} onCheckedChange={(checked) => onUpdateDraft(index, { copilot_compatibility: checked === true })} />
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <Select value={item.quota_mode} onValueChange={(value) => onUpdateDraft(index, { quota_mode: value as ChannelModelDraft["quota_mode"] })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUOTA_MODE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={item.is_public ? "1" : "0"} onValueChange={(value) => onUpdateDraft(index, { is_public: value === "1" })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">公开模型</SelectItem>
                  <SelectItem value="0">白名单模型</SelectItem>
                </SelectContent>
              </Select>
              <Select value={item.enabled ? "1" : "0"} onValueChange={(value) => onUpdateDraft(index, { enabled: value === "1" })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">启用</SelectItem>
                  <SelectItem value="0">禁用</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <Button type="button" variant="destructive" size="sm" onClick={() => onRemoveDraft(index)}>删除该草稿</Button>
            </div>
          </div>
        ))}
      </div>
      {importOpen ? (
        <div className="space-y-2 rounded-lg border border-[var(--color-border)] p-3">
          <Label className="text-xs text-[var(--color-foreground-muted)]">批量导入（每行、逗号或分号分隔一个模型名，自动作为别名与真实模型）</Label>
          <textarea
            className="min-h-24 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ring)]"
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            placeholder={"qwen3.6-35b-a3b,gemma-4-e2b-it,hy-mt2"}
          />
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={handleImport}>解析并添加</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setImportOpen(false); setImportText(""); }}>取消</Button>
          </div>
          <p className="text-xs text-[var(--color-foreground-muted)]">按逗号、换行、分号或空白自动分割并去重，已存在的别名不会重复添加。</p>
        </div>
      ) : null}
    </div>
  );
}

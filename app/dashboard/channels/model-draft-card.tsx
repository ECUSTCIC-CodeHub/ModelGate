"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { protocolLabel, type ChannelModelDraft, type Protocol } from "./channel-model";

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
  showAdvancedFields?: boolean;
}) {
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
                <Input type="number" min={1} placeholder="权重" value={item.weight} onChange={(e) => onUpdateDraft(index, { weight: Number(e.target.value) || 1 })} />
                <Input type="number" min={0} step={0.1} placeholder="Token倍率" value={item.token_multiplier} onChange={(e) => onUpdateDraft(index, { token_multiplier: Number(e.target.value) || 1 })} />
                <Input type="number" min={0} step={0.1} placeholder="请求倍率" value={item.request_multiplier} onChange={(e) => onUpdateDraft(index, { request_multiplier: Number(e.target.value) || 1 })} />
                <Input type="number" min={0} placeholder="最大并发" value={item.max_concurrency} onChange={(e) => onUpdateDraft(index, { max_concurrency: Number(e.target.value) || 0 })} />
              </div>
            ) : null}
            <Select value={item.upstream_protocol} onValueChange={(value) => onUpdateDraft(index, { upstream_protocol: value as Protocol })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {protocols.map((protocol) => (
                  <SelectItem key={protocol} value={protocol}>{protocolLabel(protocol)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className={`grid gap-3 md:grid-cols-2${showAdvancedFields ? "" : " md:col-span-2"}`}>
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
    </div>
  );
}

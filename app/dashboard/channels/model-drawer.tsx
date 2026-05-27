"use client";

import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ModelDraftCard } from "./model-draft-card";
import {
  protocolLabel,
  type Channel,
  type ChannelModelDraft,
  type ModelForm,
  type Protocol,
} from "./channel-model";

export function ModelDrawer({
  open,
  editingId,
  form,
  channels,
  selectedChannel,
  selectedChannelProtocols,
  modelDrafts,
  probingModels,
  onOpenChange,
  onSubmit,
  onFormChange,
  onChannelChange,
  onProbeModels,
  onAddModelDraft,
  onRemoveModelDraft,
  onUpdateModelDraft,
}: {
  open: boolean;
  editingId: number | null;
  form: ModelForm;
  channels: Channel[];
  selectedChannel: Channel | undefined;
  selectedChannelProtocols: Protocol[];
  modelDrafts: ChannelModelDraft[];
  probingModels: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent) => void;
  onFormChange: (patch: Partial<ModelForm>) => void;
  onChannelChange: (channelId: number) => void;
  onProbeModels: () => void;
  onAddModelDraft: (protocols: Protocol[]) => void;
  onRemoveModelDraft: (index: number) => void;
  onUpdateModelDraft: (index: number, patch: Partial<ChannelModelDraft>) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{editingId === null ? "新增模型映射" : `编辑模型 #${editingId}`}</SheetTitle>
          <SheetDescription>配置 alias、真实模型、所属渠道、公开性与启用状态。</SheetDescription>
        </SheetHeader>
        <form onSubmit={onSubmit} className="mt-4 space-y-4 overflow-y-auto pr-1">
          {editingId === null ? (
            <>
              <div className="space-y-2">
                <Label>所属渠道</Label>
                <Select value={String(form.channel_id)} onValueChange={(value) => onChannelChange(Number(value))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {channels.map((item) => (
                      <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <ModelDraftCard
                title="上游渠道模型列表"
                description="先从上游选择要加入的模型，再按需调整 alias、倍率和可见性。"
                protocols={selectedChannelProtocols}
                drafts={modelDrafts}
                probing={probingModels}
                probeDisabled={!selectedChannel}
                onProbe={onProbeModels}
                onAddDraft={onAddModelDraft}
                onRemoveDraft={onRemoveModelDraft}
                onUpdateDraft={onUpdateModelDraft}
              />
            </>
          ) : (
            <>
              <p className="text-xs text-[var(--color-foreground-muted)]">别名就是客户端请求时传入的 model，也支持 * 作为兜底模型。</p>
              <div className="space-y-2">
                <Label>别名</Label>
                <Input value={form.alias} onChange={(e) => onFormChange({ alias: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>真实模型</Label>
                <Input value={form.real_model} onChange={(e) => onFormChange({ real_model: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>所属渠道</Label>
                <Select value={String(form.channel_id)} onValueChange={(value) => onChannelChange(Number(value))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {channels.map((item) => (
                      <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>上游协议</Label>
                <Select value={form.upstream_protocol} onValueChange={(value) => onFormChange({ upstream_protocol: value as Protocol })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedChannelProtocols.map((protocol) => (
                      <SelectItem key={protocol} value={protocol}>{protocolLabel(protocol)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-2">
                  <Label>权重</Label>
                  <Input type="number" min={1} value={form.weight} onChange={(e) => onFormChange({ weight: Number(e.target.value) || 1 })} />
                </div>
                <div className="space-y-2">
                  <Label>Token 倍率</Label>
                  <Input type="number" min={0} step={0.1} value={form.token_multiplier} onChange={(e) => onFormChange({ token_multiplier: Number(e.target.value) || 1 })} />
                </div>
                <div className="space-y-2">
                  <Label>请求倍率</Label>
                  <Input type="number" min={0} step={0.1} value={form.request_multiplier} onChange={(e) => onFormChange({ request_multiplier: Number(e.target.value) || 1 })} />
                </div>
              </div>
              <p className="text-xs text-[var(--color-foreground-muted)]">倍率用于计费扣量，如 Token 倍率 2 则实际扣除 Token = 使用量 × 2。默认均为 1。</p>
              <div className="flex items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
                <div>
                  <p className="text-sm font-medium text-[var(--color-foreground)]">公开模型</p>
                  <p className="text-xs text-[var(--color-foreground-muted)]">关闭后仅被授权用户可以访问该 alias。</p>
                </div>
                <Checkbox checked={form.is_public} onCheckedChange={(checked) => onFormChange({ is_public: checked === true })} />
              </div>
              <div className="flex items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
                <div>
                  <p className="text-sm font-medium text-[var(--color-foreground)]">启用状态</p>
                  <p className="text-xs text-[var(--color-foreground-muted)]">关闭后该模型映射不会被路由命中。</p>
                </div>
                <Checkbox checked={form.enabled} onCheckedChange={(checked) => onFormChange({ enabled: checked === true })} />
              </div>
            </>
          )}
          <SheetFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit">{editingId === null ? "创建" : "保存"}</Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

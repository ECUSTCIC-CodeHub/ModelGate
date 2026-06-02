"use client";

import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  protocolOptions,
  type ChannelForm,
  type ChannelModelDraft,
  type Protocol,
} from "./channel-model";

export function ChannelDrawer({
  open,
  editingId,
  form,
  modelDrafts,
  probingModels,
  onOpenChange,
  onSubmit,
  onFormChange,
  onSupportedProtocolsChange,
  onProbeModels,
  onAddModelDraft,
  onRemoveModelDraft,
  onUpdateModelDraft,
}: {
  open: boolean;
  editingId: number | null;
  form: ChannelForm;
  modelDrafts: ChannelModelDraft[];
  probingModels: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent) => void;
  onFormChange: (patch: Partial<ChannelForm>) => void;
  onSupportedProtocolsChange: (protocols: Protocol[]) => void;
  onProbeModels: () => void;
  onAddModelDraft: (protocols: Protocol[]) => void;
  onRemoveModelDraft: (index: number) => void;
  onUpdateModelDraft: (index: number, patch: Partial<ChannelModelDraft>) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{editingId === null ? "新增接口渠道" : `编辑渠道 #${editingId}`}</SheetTitle>
          <SheetDescription>配置渠道名称、Base URL、API Key、超时与默认模型草稿。</SheetDescription>
        </SheetHeader>
        <form onSubmit={onSubmit} className="mt-4 space-y-4 overflow-y-auto pr-1">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>渠道名称</Label>
              <Input value={form.name} onChange={(e) => onFormChange({ name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>权重</Label>
              <Input type="number" min={1} value={form.weight} onChange={(e) => onFormChange({ weight: Number(e.target.value) || 1 })} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Base URL</Label>
              <Input value={form.base_url} onChange={(e) => onFormChange({ base_url: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>超时(秒)</Label>
              <Input type="number" min={1} value={form.timeout} onChange={(e) => onFormChange({ timeout: Number(e.target.value) || 60 })} />
            </div>
            <div className="space-y-2">
              <Label>最大并发</Label>
              <Input type="number" min={1} value={form.max_concurrency} onChange={(e) => onFormChange({ max_concurrency: Number(e.target.value) || 1 })} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>支持协议</Label>
              <div className="grid gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4 md:grid-cols-2">
                {protocolOptions.map((option) => {
                  const checked = form.supported_protocols.includes(option.value);
                  return (
                    <label key={option.value} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2">
                      <span className="text-sm text-[var(--color-foreground)]">{option.label}</span>
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) => {
                          const enabled = next === true;
                          const current = form.supported_protocols;
                          const protocols = enabled
                            ? [...new Set([...current, option.value])]
                            : current.filter((item) => item !== option.value);
                          onSupportedProtocolsChange(protocols.length > 0 ? protocols : [option.value]);
                        }}
                      />
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>API Key</Label>
              <Input value={form.api_key} onChange={(e) => onFormChange({ api_key: e.target.value })} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>上游 User-Agent</Label>
              <Input
                placeholder="留空则透传客户端 UA 或使用协议默认值"
                value={form.user_agent}
                onChange={(e) => onFormChange({ user_agent: e.target.value })}
              />
              <p className="text-xs text-[var(--color-foreground-muted)]">
                配置后该渠道请求固定使用此 User-Agent；留空时沿用当前透传和默认策略。
              </p>
            </div>
          </div>

          {editingId === null ? (
            <ModelDraftCard
              title="初始模型列表"
              description="别名就是客户端调用时传入的 model，支持 * 作为兜底模型。"
              protocols={form.supported_protocols}
              drafts={modelDrafts}
              probing={probingModels}
              onProbe={onProbeModels}
              onAddDraft={onAddModelDraft}
              onRemoveDraft={onRemoveModelDraft}
              onUpdateDraft={onUpdateModelDraft}
            />
          ) : null}

          <SheetFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit">{editingId === null ? "创建" : "保存"}</Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

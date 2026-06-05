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
  PERIOD_PRESETS,
  protocolLabel,
  QUOTA_MODE_OPTIONS,
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
  periodQuotaEnabled,
  dismissBlocked = false,
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
  periodQuotaEnabled: boolean;
  dismissBlocked?: boolean;
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
      <SheetContent
        side="right"
        className="sm:max-w-2xl"
        onInteractOutside={(event) => {
          if (dismissBlocked) event.preventDefault();
        }}
      >
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
                <Label>可用协议</Label>
                <div className="grid gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-3 md:grid-cols-2">
                  {selectedChannelProtocols.map((option) => {
                    const checked = form.supported_protocols.includes(option);
                    return (
                      <label key={option} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2">
                        <span className="text-sm text-[var(--color-foreground)]">{protocolLabel(option)}</span>
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) => {
                            const enabled = next === true;
                            const current = form.supported_protocols;
                            const protocols = enabled
                              ? [...new Set([...current, option])]
                              : current.filter((item) => item !== option);
                            const nextProtocols = protocols.length > 0 ? protocols : [option];
                            const nextUpstream = nextProtocols.includes(form.upstream_protocol)
                              ? form.upstream_protocol
                              : nextProtocols[0];
                            onFormChange({ supported_protocols: nextProtocols, upstream_protocol: nextUpstream });
                          }}
                        />
                      </label>
                    );
                  })}
                </div>
                <p className="text-xs text-[var(--color-foreground-muted)]">
                  勾选的协议在入站请求匹配时将直接透传，无需协议转换。至少勾选一个。
                </p>
              </div>
              <div className="space-y-2">
                <Label>默认上游协议</Label>
                <Select value={form.upstream_protocol} onValueChange={(value) => onFormChange({ upstream_protocol: value as Protocol })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {form.supported_protocols.map((protocol) => (
                      <SelectItem key={protocol} value={protocol}>{protocolLabel(protocol)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-[var(--color-foreground-muted)]">
                  当入站协议不在可用协议中时，使用此协议与上游通信。
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-4">
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
                <div className="space-y-2">
                  <Label>最大并发</Label>
                  <Input type="number" min={0} value={form.max_concurrency} onChange={(e) => onFormChange({ max_concurrency: Number(e.target.value) || 0 })} />
                </div>
              </div>
              <p className="text-xs text-[var(--color-foreground-muted)]">倍率用于计费扣量，如 Token 倍率 2 则实际扣除 Token = 使用量 x 2。最大并发为 0 时使用渠道并发限制。</p>

              <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
                <div className="space-y-2">
                  <Label>配额模式</Label>
                  <Select value={form.quota_mode} onValueChange={(value) => onFormChange({ quota_mode: value as ModelForm["quota_mode"] })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {QUOTA_MODE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-[var(--color-foreground-muted)]">
                    {QUOTA_MODE_OPTIONS.find((o) => o.value === form.quota_mode)?.description}
                  </p>
                </div>

                {form.quota_mode === "independent" ? (
                  <>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>总请求配额</Label>
                        <Input type="number" min={0} value={form.quota_requests} onChange={(e) => onFormChange({ quota_requests: e.target.value })} placeholder="留空不限制" />
                      </div>
                      <div className="space-y-2">
                        <Label>总 Token 配额</Label>
                        <Input type="number" min={0} value={form.quota_tokens} onChange={(e) => onFormChange({ quota_tokens: e.target.value })} placeholder="留空不限制" />
                      </div>
                    </div>
                    {periodQuotaEnabled ? (
                      <div className="border-t border-[var(--color-border)] pt-3">
                        <p className="mb-3 text-xs font-medium text-[var(--color-foreground-muted)]">周期配额</p>
                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="space-y-2">
                            <Label>重置周期</Label>
                            <Select
                              value={form.quota_period_preset || "none"}
                              onValueChange={(value) => onFormChange({
                                quota_period_preset: value === "none" ? "" : value,
                                quota_period_custom: value === "custom" ? form.quota_period_custom : "",
                              })}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="不限制" />
                              </SelectTrigger>
                              <SelectContent>
                                {PERIOD_PRESETS.map((preset) => (
                                  <SelectItem key={preset.value || "none"} value={preset.value || "none"}>
                                    {preset.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          {form.quota_period_preset === "custom" ? (
                            <div className="space-y-2">
                              <Label>自定义周期（秒）</Label>
                              <Input
                                type="number"
                                min={60}
                                value={form.quota_period_custom}
                                onChange={(e) => onFormChange({ quota_period_custom: e.target.value })}
                                placeholder="如 7200 = 2小时"
                              />
                            </div>
                          ) : <div />}
                          <div className="space-y-2">
                            <Label>周期请求配额</Label>
                            <Input
                              type="number"
                              min={0}
                              value={form.period_quota_requests}
                              onChange={(e) => onFormChange({ period_quota_requests: e.target.value })}
                              placeholder="留空不限制"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>周期 Token 配额</Label>
                            <Input
                              type="number"
                              min={0}
                              value={form.period_quota_tokens}
                              onChange={(e) => onFormChange({ period_quota_tokens: e.target.value })}
                              placeholder="留空不限制"
                            />
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>

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

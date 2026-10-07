"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ModelDraftCard } from "./model-draft-card";
import { ChannelQuotaFields } from "./channel-quota-fields";
import { UaRestrictionsEditor, type UaRestrictionRuleDraft, rulesToJson, jsonToRules } from "@/components/ua-restrictions-editor";
import { TimeWindowEditor, jsonToWindows } from "@/components/time-window-editor";
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
  onOpenModelsDev,
  modelsDevLoading = false,
  periodQuotaEnabled,
  canViewApiKey = true,
  canManagePrivacy = true,
  hasStoredApiKey = false,
  dismissBlocked = false,
  onOpenChange,
  onSubmit,
  onFormChange,
  onSupportedProtocolsChange,
  onProbeModels,
  onAddModelDraft,
  onRemoveModelDraft,
  onUpdateModelDraft,
  onImportModelDrafts,
}: {
  open: boolean;
  editingId: number | null;
  form: ChannelForm;
  modelDrafts: ChannelModelDraft[];
  probingModels: boolean;
  onOpenModelsDev?: () => void;
  modelsDevLoading?: boolean;
  periodQuotaEnabled: boolean;
  canViewApiKey?: boolean;
  canManagePrivacy?: boolean;
  hasStoredApiKey?: boolean;
  dismissBlocked?: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent) => void;
  onFormChange: (patch: Partial<ChannelForm>) => void;
  onSupportedProtocolsChange: (protocols: Protocol[]) => void;
  onProbeModels: () => void;
  onAddModelDraft: (protocols: Protocol[]) => void;
  onRemoveModelDraft: (index: number) => void;
  onUpdateModelDraft: (index: number, patch: Partial<ChannelModelDraft>) => void;
  onImportModelDrafts: (names: string[], protocols: Protocol[]) => void;
}) {
  const [confirmClearKeyOpen, setConfirmClearKeyOpen] = useState(false);
  // 已存密钥在界面上是脱敏值，清空输入框即代表清空密钥，这里必须二次确认
  const clearingStoredKey = editingId !== null && canViewApiKey && hasStoredApiKey && form.api_key === "";
  // 与接口一致：非添加人不能修改私有渠道的上游地址与代理
  const addressLocked = editingId !== null && !canViewApiKey;

  function handleSubmit(event: FormEvent) {
    if (clearingStoredKey) {
      event.preventDefault();
      setConfirmClearKeyOpen(true);
      return;
    }
    onSubmit(event);
  }

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
          <SheetTitle>{editingId === null ? "新增接口渠道" : `编辑渠道 #${editingId}`}</SheetTitle>
          <SheetDescription>配置渠道名称、Base URL、API Key、超时与默认模型草稿。</SheetDescription>
        </SheetHeader>
        <form onSubmit={handleSubmit} className="mt-4 space-y-4 overflow-y-auto pr-1">
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
              <Input
                value={form.base_url}
                disabled={addressLocked}
                onChange={(e) => onFormChange({ base_url: e.target.value })}
              />
              {addressLocked ? (
                <p className="text-xs text-[var(--color-foreground-muted)]">
                  该渠道的 API Key 仅添加人可见，仅添加人可修改上游地址与代理。
                </p>
              ) : null}
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
              {form.supported_protocols.length > 1 && (
                <p className="text-xs text-[var(--color-foreground-muted)]">
                  勾选多种协议后，模型可选择这些协议进行透传，当入站请求协议匹配时将直接透传，无需协议转换。
                </p>
              )}
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>API Key</Label>
              {editingId !== null && !canViewApiKey ? (
                <Input disabled placeholder="仅添加人可见" />
              ) : (
                <Input value={form.api_key} onChange={(e) => onFormChange({ api_key: e.target.value })} />
              )}
              <Label className="flex items-center gap-2">
                <Checkbox
                  checked={form.api_key_private}
                  disabled={editingId !== null && !canManagePrivacy}
                  onCheckedChange={(next) => onFormChange({ api_key_private: next === true })}
                />
                仅添加人可见
              </Label>
              <p className="text-xs text-[var(--color-foreground-muted)]">
                勾选后该渠道的 API Key 仅添加人可见和修改，其他管理员看不到。无添加人的渠道勾选后，当前操作者将成为添加人；仅添加人可取消勾选。
              </p>
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
            <div className="space-y-2 md:col-span-2">
              <Label>代理地址</Label>
              <Input
                placeholder="留空直连上游"
                value={form.proxy_url}
                disabled={addressLocked}
                onChange={(e) => onFormChange({ proxy_url: e.target.value })}
              />
              <p className="text-xs text-[var(--color-foreground-muted)]">
                留空直连；支持 http:// 或 https:// 代理地址。
              </p>
            </div>
            <div className="space-y-2">
              <Label>分组</Label>
              <Input
                placeholder="留空表示未分组"
                maxLength={64}
                value={form.group_name}
                onChange={(e) => onFormChange({ group_name: e.target.value })}
              />
              <p className="text-xs text-[var(--color-foreground-muted)]">
                仅用于渠道列表组织，不参与请求路由。最长 64 字符，保存时去掉首尾空白。
              </p>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>自定义 Header</Label>
              <textarea
                className="min-h-20 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ring)] disabled:opacity-50"
                placeholder={"每行一条，例如：\nX-Org-Id: team-a"}
                value={form.custom_headers}
                disabled={addressLocked}
                onChange={(e) => onFormChange({ custom_headers: e.target.value })}
              />
              <p className="text-xs text-[var(--color-foreground-muted)]">
                附加到该渠道所有上游请求（含模型测试与模型列表探测），透传路径下会覆盖客户端的同名 Header。
                最多 20 对；Authorization、Content-Type、Host、Cookie 等由网关托管的 Header 不允许配置。
              </p>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>剔除请求体字段</Label>
              <textarea
                className="min-h-16 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ring)] disabled:opacity-50"
                placeholder={"每行一个顶层字段名，例如：\nmetadata"}
                value={form.request_body_omit}
                onChange={(e) => onFormChange({ request_body_omit: e.target.value })}
              />
              <p className="text-xs text-[var(--color-foreground-muted)]">
                发往该渠道上游前从请求体中删除这些顶层字段，适用于部分上游不支持特定字段（如智谱不接受 metadata）的场景。
                每行一个字段名，仅允许字母、数字与下划线，最多 16 项、单个最长 64 字符；留空则不剔除。
                model、messages 等承载请求语义的字段不允许剔除。other 通用转发路径不经过该处理。
              </p>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label className="flex items-center gap-2">
                <Checkbox
                  checked={form.force_include_usage}
                  onCheckedChange={(next) => onFormChange({ force_include_usage: next === true })}
                />
                强制注入 include_usage
              </Label>
              <p className="text-xs text-[var(--color-foreground-muted)]">
                开启后该渠道请求向上游注入 stream_options.include_usage，部分上游（如微软）不支持此参数时请关闭。
              </p>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>User-Agent 限制</Label>
              <UaRestrictionsEditor
                rules={jsonToRules(form.ua_restrictions)}
                onChange={(rules: UaRestrictionRuleDraft[]) => onFormChange({ ua_restrictions: rulesToJson(rules) })}
              />
              <p className="text-xs text-[var(--color-foreground-muted)]">
                配置后仅匹配规则的客户端可访问该渠道；留空则不限制。优先级低于全站限制。
              </p>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>过期时间</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="datetime-local"
                  className="flex-1"
                  value={form.expires_at}
                  onChange={(e) => onFormChange({ expires_at: e.target.value })}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onFormChange({ expires_at: "" })}
                  disabled={!form.expires_at}
                >
                  清除
                </Button>
              </div>
              <p className="text-xs text-[var(--color-foreground-muted)]">
                留空表示永不过期。到达该时间后渠道将自动不可用；管理员对任一渠道操作后，过期的渠道会被彻底禁用并级联禁用其模型。
              </p>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>限制时段</Label>
              <TimeWindowEditor
                windows={jsonToWindows(form.time_restrictions)}
                onChange={(json) => onFormChange({ time_restrictions: json })}
              />
              <p className="text-xs text-[var(--color-foreground-muted)]">
                配置后渠道仅在这些时段内可用。留空则不限制。
              </p>
            </div>
          </div>

          <ChannelQuotaFields
            form={form}
            periodQuotaEnabled={periodQuotaEnabled}
            onChange={onFormChange}
          />

          {editingId === null ? (
            <ModelDraftCard
              title="初始模型列表"
              description="填写客户端模型名与上游真实模型名，支持 * 作为兜底模型。"
              protocols={form.supported_protocols}
              drafts={modelDrafts}
              probing={probingModels}
              onProbe={onProbeModels}
              onAddDraft={onAddModelDraft}
              onRemoveDraft={onRemoveModelDraft}
              onUpdateDraft={onUpdateModelDraft}
              onImportDrafts={onImportModelDrafts}
              onOpenModelsDev={onOpenModelsDev}
              modelsDevLoading={modelsDevLoading}
              showAdvancedFields={false}
            />
          ) : null}

          <SheetFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit">{editingId === null ? "创建" : "保存"}</Button>
          </SheetFooter>
        </form>

        <AlertDialog open={confirmClearKeyOpen} onOpenChange={setConfirmClearKeyOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>清空该渠道的 API Key？</AlertDialogTitle>
              <AlertDialogDescription>
                输入框为空将把服务端已保存的密钥清空，清空后该渠道会立即无法访问上游，直到重新填写密钥。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmClearKeyOpen(false);
                  onSubmit({ preventDefault: () => {} } as FormEvent);
                }}
              >
                确认清空
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}

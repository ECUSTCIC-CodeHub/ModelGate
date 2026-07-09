"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export type SenderForm = {
  name: string;
  host: string;
  port: number;
  secure: boolean;
  auth_user: string;
  auth_pass: string;
  from_address: string;
  from_name: string;
  daily_limit: number;
  priority: number;
  enabled: boolean;
};

export const PASSWORD_MASK = "••••••••";

export const initialSenderForm: SenderForm = {
  name: "",
  host: "",
  port: 465,
  secure: true,
  auth_user: "",
  auth_pass: "",
  from_address: "",
  from_name: "",
  daily_limit: 0,
  priority: 0,
  enabled: true,
};

export function EmailSenderDialog({
  open,
  onOpenChange,
  editing,
  initial,
  onSave,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: boolean;
  initial: SenderForm;
  onSave: (form: SenderForm) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<SenderForm>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function patch(p: Partial<SenderForm>) {
    setForm((prev) => ({ ...prev, ...p }));
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = "请填写账号名称";
    if (!form.host.trim()) next.host = "请填写 SMTP 服务器";
    if (!form.from_address.trim()) next.from_address = "请填写发件地址";
    else if (!/.+@.+\..+/.test(form.from_address.trim())) next.from_address = "发件地址格式不正确";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function handleSave() {
    if (!validate()) return;
    onSave({
      ...form,
      name: form.name.trim(),
      host: form.host.trim(),
      from_address: form.from_address.trim(),
      auth_user: form.auth_user.trim(),
      from_name: form.from_name.trim(),
      port: Math.max(1, Math.min(65535, Math.trunc(form.port) || 25)),
      daily_limit: Math.max(0, Math.trunc(form.daily_limit)),
      priority: Math.trunc(form.priority),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑发件账号" : "新增发件账号"}</DialogTitle>
          <DialogDescription>配置 SMTP 服务器与发件身份，可添加多个账号并按优先级与单日上限分流。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
          <div className="space-y-2">
            <Label>账号名称</Label>
            <Input
              placeholder="如：主账号 / 备用邮箱"
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
            {errors.name ? <p className="text-xs text-red-500">{errors.name}</p> : null}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label>SMTP 服务器</Label>
              <Input placeholder="smtp.example.com" value={form.host} onChange={(e) => patch({ host: e.target.value })} />
              {errors.host ? <p className="text-xs text-red-500">{errors.host}</p> : null}
            </div>
            <div className="space-y-2">
              <Label>端口</Label>
              <Input
                type="number"
                value={form.port}
                onChange={(e) => patch({ port: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3">
            <div>
              <p className="text-sm font-medium text-[var(--color-foreground)]">使用 SSL/TLS 加密连接</p>
              <p className="text-xs text-[var(--color-foreground-muted)]">开启表示连接即加密（如 465）；关闭则使用 STARTTLS（如 587/25）。</p>
            </div>
            <Switch checked={form.secure} onCheckedChange={(v) => patch({ secure: v })} />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label>认证用户名</Label>
              <Input value={form.auth_user} onChange={(e) => patch({ auth_user: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>认证密码</Label>
              <Input
                type="password"
                autoComplete="new-password"
                placeholder={editing ? "留空表示不修改" : "可选，留空则不使用认证"}
                value={form.auth_pass}
                onChange={(e) => patch({ auth_pass: e.target.value })}
              />
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label>发件地址</Label>
              <Input placeholder="noreply@example.com" value={form.from_address} onChange={(e) => patch({ from_address: e.target.value })} />
              {errors.from_address ? <p className="text-xs text-red-500">{errors.from_address}</p> : null}
            </div>
            <div className="space-y-2">
              <Label>发件名称</Label>
              <Input placeholder="ModelGate 通知" value={form.from_name} onChange={(e) => patch({ from_name: e.target.value })} />
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label>单日发送上限</Label>
              <Input
                type="number"
                min={0}
                value={form.daily_limit}
                onChange={(e) => patch({ daily_limit: Number(e.target.value) })}
              />
              <p className="text-xs text-[var(--color-foreground-muted)]">0 表示不限制。达到上限后该账号当日不再发送。</p>
            </div>
            <div className="space-y-2">
              <Label>优先级</Label>
              <Input
                type="number"
                value={form.priority}
                onChange={(e) => patch({ priority: Number(e.target.value) })}
              />
              <p className="text-xs text-[var(--color-foreground-muted)]">数值越大越优先使用，同优先级间轮流分流。</p>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3">
            <p className="text-sm font-medium text-[var(--color-foreground)]">启用该账号</p>
            <Switch checked={form.enabled} onCheckedChange={(v) => patch({ enabled: v })} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={handleSave} disabled={saving}>{editing ? "保存" : "添加"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

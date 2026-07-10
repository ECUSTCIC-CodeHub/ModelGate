"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { GroupOption, UserForm } from "./user-model";

type UserBasicFieldsProps = {
  form: UserForm;
  editingId: number | null;
  groupOptions: GroupOption[];
  onChange: (patch: Partial<UserForm>) => void;
};

export function UserBasicFields({ form, editingId, groupOptions, onChange }: UserBasicFieldsProps) {
  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
      <p className="text-sm font-medium text-[var(--color-foreground)]">基础信息</p>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label>用户名</Label>
          <Input
            pattern="[A-Za-z0-9]+"
            title="仅支持英文字母和数字"
            value={form.username}
            onChange={(e) => onChange({ username: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label>邮箱</Label>
          <Input
            type="email"
            placeholder="用于 OIDC 账号关联与接收邮件通知"
            value={form.email}
            onChange={(e) => onChange({ email: e.target.value })}
          />
        </div>
        {editingId === null ? (
          <div className="space-y-2">
            <Label>密码</Label>
            <Input type="password" value={form.password} onChange={(e) => onChange({ password: e.target.value })} />
          </div>
        ) : (
          <div className="space-y-2">
            <Label>重置密码</Label>
            <Input
              type="password"
              placeholder="留空表示不修改"
              value={form.new_password}
              onChange={(e) => onChange({ new_password: e.target.value })}
            />
          </div>
        )}
        <div className="space-y-2">
          <Label>角色</Label>
          <Select value={form.role} onValueChange={(value) => onChange({ role: value as "admin" | "user" })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="user">普通用户</SelectItem>
              <SelectItem value="admin">管理员</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>状态</Label>
          <Select value={form.enabled ? "1" : "0"} onValueChange={(value) => onChange({ enabled: value === "1" })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">启用</SelectItem>
              <SelectItem value="0">禁用</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>用户组</Label>
          <Select value={form.group_id} onValueChange={(value) => onChange({ group_id: value })}>
            <SelectTrigger>
              <SelectValue placeholder="选择用户组" />
            </SelectTrigger>
            <SelectContent>
              {groupOptions.map((group) => (
                <SelectItem key={group.id} value={String(group.id)}>
                  {group.name}{group.is_default ? "（默认）" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2 md:col-span-2">
          <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
            <Checkbox checked={form.group_locked} onCheckedChange={(value) => onChange({ group_locked: value === true })} />
            锁定身份组（OIDC 登录不覆盖）
          </label>
          <p className="text-xs text-[var(--color-foreground-muted)]">开启后该用户的身份组由管理员手动指定，OIDC 登录与过期回收都不会修改它。</p>
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label>管理员备注</Label>
          <textarea
            className="flex min-h-24 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3 text-sm text-[var(--color-foreground)] shadow-[var(--shadow-inner-highlight)] placeholder:text-[var(--color-foreground-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20"
            placeholder="仅管理员可见，可记录来源、用途、客户信息等"
            value={form.note}
            onChange={(e) => onChange({ note: e.target.value })}
            maxLength={500}
          />
        </div>
      </div>
    </div>
  );
}

"use client";

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
import { validateClaimExpr } from "@/lib/shared/claim-expr";
import type { GroupForm } from "./group-model";

type GroupBasicFieldsProps = {
  form: GroupForm;
  oidcFeatureEnabled: boolean;
  onChange: (patch: Partial<GroupForm>) => void;
};

function ClaimValidationMessage({ value }: { value: string }) {
  if (!value.trim()) {
    return (
      <p className="text-xs text-[var(--color-foreground-muted)]">
        支持操作符: ==、!=、contains、matches（正则）、exists；逻辑: AND、OR、括号分组；点号访问嵌套字段。留空则不参与 OIDC 组映射。
      </p>
    );
  }

  const result = validateClaimExpr(value);
  return result.valid
    ? <p className="text-xs text-[var(--color-accent)]">&#10003; 表达式语法正确</p>
    : <p className="text-xs text-[var(--color-destructive)]">&#10007; {result.error}</p>;
}

export function GroupBasicFields({
  form,
  oidcFeatureEnabled,
  onChange,
}: GroupBasicFieldsProps) {
  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
      <p className="text-sm font-medium text-[var(--color-foreground)]">基础信息</p>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label>组名</Label>
          <Input
            value={form.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="如 default、premium、vip"
          />
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
        <div className="space-y-2 md:col-span-2">
          <Label>描述</Label>
          <Input
            value={form.description}
            onChange={(e) => onChange({ description: e.target.value })}
            placeholder="组描述（可选）"
            maxLength={200}
          />
        </div>
        {oidcFeatureEnabled ? (
          <>
            <div className="space-y-2 md:col-span-2">
              <Label>OIDC Claim 表达式</Label>
              <textarea
                className="flex w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono placeholder:text-[var(--color-foreground-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-foreground-subtle)] disabled:opacity-50"
                rows={3}
                value={form.oidc_claim_expr}
                onChange={(e) => onChange({ oidc_claim_expr: e.target.value })}
                placeholder={'groups contains "vip"\nrole == "admin" OR role == "superadmin"'}
                maxLength={512}
              />
              <ClaimValidationMessage value={form.oidc_claim_expr} />
            </div>
            <div className="space-y-2">
              <Label>匹配优先级</Label>
              <Input
                type="number"
                min={0}
                max={9999}
                value={form.oidc_claim_priority}
                onChange={(e) => onChange({ oidc_claim_priority: e.target.value })}
                placeholder="0"
              />
              <p className="text-xs text-[var(--color-foreground-muted)]">数值越大越优先匹配，用于解决多个组表达式同时满足时的冲突。</p>
            </div>
          </>
        ) : null}
        <div className="flex items-center gap-3 md:col-span-2">
          <Checkbox
            checked={form.is_default}
            onCheckedChange={(checked) => onChange({ is_default: checked === true })}
          />
          <Label>设为默认组（新注册用户将自动加入此组）</Label>
        </div>
      </div>
    </div>
  );
}

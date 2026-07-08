"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type UaRestrictionRuleDraft = {
  pattern: string;
  mode: "allow" | "deny";
  error_code: string;
  error_message: string;
};

const EMPTY_RULE: UaRestrictionRuleDraft = {
  pattern: "",
  mode: "deny",
  error_code: "403",
  error_message: "客户端 User-Agent 不被允许访问该资源。",
};

export function rulesToJson(rules: UaRestrictionRuleDraft[]): string {
  const cleaned = rules
    .filter((rule) => rule.pattern.trim().length > 0)
    .map((rule) => ({
      pattern: rule.pattern.trim(),
      mode: rule.mode,
      error_code: Math.trunc(Number(rule.error_code)) || 403,
      error_message: rule.error_message.trim() || "客户端 User-Agent 不被允许访问该资源。",
    }));
  return JSON.stringify(cleaned);
}

export function jsonToRules(raw: string | undefined | null): UaRestrictionRuleDraft[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => ({
        pattern: typeof item.pattern === "string" ? item.pattern : "",
        mode: item.mode === "allow" ? "allow" : "deny",
        error_code: String(item.error_code ?? "403"),
        error_message: typeof item.error_message === "string" ? item.error_message : "",
      }));
  } catch {
    return [];
  }
}

export function UaRestrictionsEditor({
  rules,
  onChange,
}: {
  rules: UaRestrictionRuleDraft[];
  onChange: (rules: UaRestrictionRuleDraft[]) => void;
}) {
  function update(index: number, patch: Partial<UaRestrictionRuleDraft>) {
    onChange(rules.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function remove(index: number) {
    onChange(rules.filter((_, i) => i !== index));
  }

  function add() {
    onChange([...rules, { ...EMPTY_RULE }]);
  }

  return (
    <div className="space-y-3">
      {rules.map((rule, index) => (
        <div key={index} className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-3">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs">规则 #{index + 1}</Label>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(index)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          <div className="grid gap-2 md:grid-cols-[1fr_120px]">
            <div className="space-y-1">
              <Label className="text-xs">匹配模式</Label>
              <Input
                value={rule.pattern}
                placeholder="如 Mozilla/* 或 regex:.*bot.*"
                onChange={(e) => update(index, { pattern: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">动作</Label>
              <Select value={rule.mode} onValueChange={(value) => update(index, { mode: value as "allow" | "deny" })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="deny">拒绝</SelectItem>
                  <SelectItem value="allow">允许</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-[120px_1fr]">
            <div className="space-y-1">
              <Label className="text-xs">错误码</Label>
              <Input
                type="number"
                min={100}
                max={599}
                value={rule.error_code}
                onChange={(e) => update(index, { error_code: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">错误提示</Label>
              <Input
                value={rule.error_message}
                onChange={(e) => update(index, { error_message: e.target.value })}
              />
            </div>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" className="w-full" onClick={add}>
        <Plus className="h-4 w-4" /> 添加规则
      </Button>
      <p className="text-xs text-[var(--color-foreground-muted)]">
        模式支持通配符（* 匹配任意字符，不区分大小写）或正则表达式（以 regex: 开头）。留空模式仅匹配未携带 UA 的请求。命中拒绝立即拦截；仅当该层级配置了规则且命中允许时放行。
      </p>
    </div>
  );
}

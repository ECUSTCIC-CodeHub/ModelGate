"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type BrandGroupDraft = {
  label: string;
  pattern: string;
};

const EMPTY_GROUP: BrandGroupDraft = { label: "", pattern: "" };

export function brandGroupsToJson(groups: BrandGroupDraft[]): string {
  const cleaned = groups
    .filter((group) => group.label.trim() || group.pattern.trim())
    .map((group) => ({ label: group.label.trim(), pattern: group.pattern.trim() }));
  return JSON.stringify(cleaned);
}

export function jsonToBrandGroups(raw: string | undefined | null): BrandGroupDraft[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => ({
        label: typeof item.label === "string" ? item.label : "",
        pattern: typeof item.pattern === "string" ? item.pattern : "",
      }));
  } catch {
    return [];
  }
}

export function ModelBrandGroupsEditor({
  groups,
  onChange,
}: {
  groups: BrandGroupDraft[];
  onChange: (groups: BrandGroupDraft[]) => void;
}) {
  const [internal, setInternal] = useState<BrandGroupDraft[]>(() => groups);
  const lastEmitted = useRef<string>(brandGroupsToJson(groups));

  useEffect(() => {
    const serialized = brandGroupsToJson(groups);
    if (serialized !== lastEmitted.current) {
      setInternal(groups);
    }
  }, [groups]);

  function emit(next: BrandGroupDraft[]) {
    lastEmitted.current = brandGroupsToJson(next);
    onChange(next);
  }

  function update(index: number, patch: Partial<BrandGroupDraft>) {
    const next = internal.map((item, i) => (i === index ? { ...item, ...patch } : item));
    setInternal(next);
    emit(next);
  }

  function remove(index: number) {
    const next = internal.filter((_, i) => i !== index);
    setInternal(next);
    emit(next);
  }

  function add() {
    const next = [...internal, { ...EMPTY_GROUP }];
    setInternal(next);
    emit(next);
  }

  return (
    <div className="space-y-3">
      {internal.map((group, index) => (
        <div key={index} className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label className="text-xs">品牌名 #{index + 1}</Label>
            <Input
              value={group.label}
              placeholder="如 深度求索"
              onChange={(e) => update(index, { label: e.target.value })}
            />
          </div>
          <div className="flex-1 space-y-1">
            <Label className="text-xs">ID 前缀规则</Label>
            <Input
              value={group.pattern}
              placeholder="如 deepseek*"
              onChange={(e) => update(index, { pattern: e.target.value })}
            />
          </div>
          <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => remove(index)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" className="w-full" onClick={add}>
        <Plus className="h-4 w-4" /> 添加品牌组
      </Button>
      <p className="text-xs text-[var(--color-foreground-muted)]">
        按模型 ID 前缀归组，用于模型列表按品牌筛选。前缀规则支持通配符 *（如 deepseek* 匹配所有以 deepseek 开头的模型 ID）。未命中任何品牌组的模型归入「其他」。
      </p>
    </div>
  );
}

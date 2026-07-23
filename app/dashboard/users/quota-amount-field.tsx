"use client";

import { type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const MODE_INHERIT = "inherit";
const MODE_UNLIMITED = "unlimited";
const MODE_CUSTOM = "custom";

type Mode = typeof MODE_INHERIT | typeof MODE_UNLIMITED | typeof MODE_CUSTOM;

function deriveMode(value: string): Mode {
  const trimmed = value.trim();
  if (trimmed === "") return MODE_INHERIT;
  if (trimmed === "-1") return MODE_UNLIMITED;
  return MODE_CUSTOM;
}

type QuotaAmountFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  fallbackCustom?: string;
  hint?: ReactNode;
};

export function QuotaAmountField({ label, value, onChange, fallbackCustom, hint }: QuotaAmountFieldProps) {
  const mode = deriveMode(value);

  function selectMode(next: Mode) {
    if (next === MODE_INHERIT) {
      onChange("");
      return;
    }
    if (next === MODE_UNLIMITED) {
      onChange("-1");
      return;
    }
    const current = value.trim();
    const seed = /^\d+$/.test(current)
      ? current
      : fallbackCustom && fallbackCustom.trim() !== ""
        ? fallbackCustom
        : "0";
    onChange(seed);
  }

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={mode} onValueChange={(v) => selectMode(v as Mode)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={MODE_INHERIT}>继承组</SelectItem>
          <SelectItem value={MODE_UNLIMITED}>不限制（覆盖组）</SelectItem>
          <SelectItem value={MODE_CUSTOM}>自定义数值</SelectItem>
        </SelectContent>
      </Select>
      {mode === MODE_CUSTOM ? (
        <Input
          type="number"
          min={0}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0 表示禁止"
        />
      ) : null}
      {hint}
    </div>
  );
}

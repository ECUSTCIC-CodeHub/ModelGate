"use client";

import { useEffect, useState } from "react";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  isValidHexColor,
  THEME_PRESETS,
  getHoverColor,
  getContrastText,
  getMutedColor,
} from "@/lib/shared/color";

function PreviewDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-4 w-4 rounded-full border border-[var(--color-border)]"
      style={{ backgroundColor: color }}
    />
  );
}

export function AppearanceSettingsCard({
  themeColor,
  setThemeColor,
}: {
  themeColor: string;
  setThemeColor: (value: string) => void;
}) {
  const [inputValue, setInputValue] = useState(themeColor);

  useEffect(() => {
    setInputValue(themeColor);
  }, [themeColor]);

  function applyColor(value: string) {
    const normalized = value.toLowerCase();
    setInputValue(normalized);
    if (isValidHexColor(normalized)) {
      setThemeColor(normalized);
    }
  }

  function handleInputChange(value: string) {
    setInputValue(value);
    const normalized = value.toLowerCase();
    if (isValidHexColor(normalized)) {
      setThemeColor(normalized);
    }
  }

  function handleReset() {
    setInputValue("");
    setThemeColor("");
  }

  const previewColor = isValidHexColor(inputValue) ? inputValue : undefined;

  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="外观设置"
          description="自定义主题色，留空则使用默认靛蓝色。"
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-[var(--color-foreground)]">
            预设色板
          </label>
          <div className="flex flex-wrap gap-2">
            {THEME_PRESETS.map((preset) => (
              <button
                key={preset.color}
                type="button"
                className="group flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium transition-colors hover:border-[var(--color-border-hover)] hover:bg-[var(--color-surface-hover)]"
                onClick={() => applyColor(preset.color)}
                title={preset.name}
              >
                <PreviewDot color={preset.color} />
                <span className="text-[var(--color-foreground-secondary)]">{preset.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-[var(--color-foreground)]">
            自定义颜色
          </label>
          <div className="flex items-center gap-3">
            <Input
              placeholder="#00518f"
              value={inputValue}
              onChange={(e) => handleInputChange(e.target.value)}
              maxLength={7}
              className="max-w-[180px] font-mono"
            />
            <input
              type="color"
              value={previewColor ?? "#6366f1"}
              onChange={(e) => applyColor(e.target.value)}
              className="h-10 w-10 cursor-pointer rounded-md border border-[var(--color-border)] bg-transparent"
            />
            {themeColor ? (
              <button
                type="button"
                className="text-xs text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)]"
                onClick={handleReset}
              >
                恢复默认
              </button>
            ) : null}
          </div>
          <p className="text-xs text-[var(--color-foreground-muted)]">
            输入十六进制颜色代码（如 #00518f），或点击色轮选择颜色。
          </p>
        </div>

        {previewColor ? (
          <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--color-foreground)]">
              预览
            </label>
            <div className="flex flex-wrap gap-2">
              <span
                className="inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium"
                style={{ backgroundColor: previewColor, color: getContrastText(previewColor) }}
              >
                主按钮
              </span>
              <span
                className="inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium"
                style={{ backgroundColor: getHoverColor(previewColor), color: getContrastText(getHoverColor(previewColor)) }}
              >
                悬停态
              </span>
              <span
                className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium"
                style={{ borderColor: previewColor, color: previewColor }}
              >
                边框
              </span>
              <span
                className="inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium"
                style={{ backgroundColor: getMutedColor(previewColor), color: previewColor }}
              >
                淡背景
              </span>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

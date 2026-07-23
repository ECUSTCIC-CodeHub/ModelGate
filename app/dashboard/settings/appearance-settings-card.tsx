"use client";

import { useEffect, useState } from "react";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Monitor, Moon, Sun, Type } from "lucide-react";
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

function OptionGrid<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; desc: string; icon: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors ${
              active
                ? "border-[var(--color-accent)] bg-[var(--color-accent-muted)]"
                : "border-[var(--color-border)] hover:border-[var(--color-border-hover)] hover:bg-[var(--color-surface-hover)]"
            }`}
          >
            <span className="mt-0.5 text-[var(--color-foreground-secondary)]">{option.icon}</span>
            <span>
              <span className="block text-sm font-medium text-[var(--color-foreground)]">
                {option.label}
              </span>
              <span className="mt-0.5 block text-xs text-[var(--color-foreground-muted)]">
                {option.desc}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function AppearanceSettingsCard({
  themeColor,
  setThemeColor,
  logoUrl,
  setLogoUrl,
  logoSquareUrl,
  setLogoSquareUrl,
  defaultAppearance,
  setDefaultAppearance,
  defaultMode,
  setDefaultMode,
}: {
  themeColor: string;
  setThemeColor: (value: string) => void;
  logoUrl: string;
  setLogoUrl: (value: string) => void;
  logoSquareUrl: string;
  setLogoSquareUrl: (value: string) => void;
  defaultAppearance: "default" | "retro";
  setDefaultAppearance: (value: "default" | "retro") => void;
  defaultMode: "light" | "dark" | "system";
  setDefaultMode: (value: "light" | "dark" | "system") => void;
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
          description="自定义站点主题色与品牌 Logo，留空则使用默认值。"
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <Separator />

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

        <Separator />

        <div className="space-y-2">
          <div>
            <label className="text-sm font-medium text-[var(--color-foreground)]">
              默认显示风格
            </label>
            <p className="mt-0.5 text-xs text-[var(--color-foreground-muted)]">
              新用户或未设置个人偏好时的默认界面风格。
            </p>
          </div>
          <OptionGrid
            options={[
              { value: "default" as const, label: "现代", desc: "当前默认界面风格", icon: <Monitor className="h-4 w-4" /> },
              { value: "retro" as const, label: "复古", desc: "90 年代纯文本风格", icon: <Type className="h-4 w-4" /> },
            ]}
            value={defaultAppearance}
            onChange={setDefaultAppearance}
          />
        </div>

        <div className="space-y-2">
          <div>
            <label className="text-sm font-medium text-[var(--color-foreground)]">
              默认明暗模式
            </label>
            <p className="mt-0.5 text-xs text-[var(--color-foreground-muted)]">
              新用户或未设置个人偏好时的默认明暗模式。
            </p>
          </div>
          <OptionGrid
            options={[
              { value: "light" as const, label: "浅色", desc: "明亮界面", icon: <Sun className="h-4 w-4" /> },
              { value: "dark" as const, label: "深色", desc: "护眼暗色", icon: <Moon className="h-4 w-4" /> },
              { value: "system" as const, label: "跟随系统", desc: "自动适配系统主题", icon: <Monitor className="h-4 w-4" /> },
            ]}
            value={defaultMode}
            onChange={setDefaultMode}
          />
        </div>

        <Separator />

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-[var(--color-foreground)]">
              Brand Logo
            </label>
            <p className="mt-0.5 text-xs text-[var(--color-foreground-muted)]">
              设置后侧边栏和主页将用 Logo 图片替换 "ModelGate" 文字。
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-[var(--color-foreground-secondary)]">
              宽版 Logo（主页、宽屏侧边栏）
            </label>
            <Input
              placeholder="https://example.com/logo-wide.svg"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              className="max-w-lg"
            />
            {logoUrl ? (
              <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-white p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logoUrl} alt="宽版 Logo 预览" className="h-8 w-auto object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-[var(--color-foreground-secondary)]">
              方形 Logo（窄屏侧边栏）
            </label>
            <Input
              placeholder="https://example.com/logo-square.svg"
              value={logoSquareUrl}
              onChange={(e) => setLogoSquareUrl(e.target.value)}
              className="max-w-lg"
            />
            {logoSquareUrl ? (
              <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-white p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logoSquareUrl} alt="方形 Logo 预览" className="h-8 w-auto object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              </div>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { useTheme } from "@/components/providers/theme-provider";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Monitor, Moon, Sun, Type } from "lucide-react";
import { ensureLoggedIn, getCachedProfile } from "@/lib/auth/client-auth";

type Option<T> = {
  value: T;
  label: string;
  desc: string;
  icon: React.ReactNode;
};

function OptionGrid<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Option<T>[];
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

export default function PersonalSettingsPage() {
  const router = useRouter();
  const initialProfile = useAuthProfile();
  const { appearance, mode, setAppearance, setMode } = useTheme();
  const [role, setRole] = useState<"admin" | "user">(
    () => initialProfile?.role ?? getCachedProfile()?.role ?? "user",
  );

  useEffect(() => {
    void (async () => {
      const profile = await ensureLoggedIn(router);
      if (profile) setRole(profile.role as "admin" | "user");
    })();
  }, [router]);

  const appearanceOptions: Option<"default" | "retro">[] = [
    { value: "default", label: "现代", desc: "当前默认界面风格", icon: <Monitor className="h-4 w-4" /> },
    { value: "retro", label: "复古", desc: "90 年代纯文本风格", icon: <Type className="h-4 w-4" /> },
  ];

  const modeOptions: Option<"light" | "dark" | "system">[] = [
    { value: "light", label: "浅色", desc: "明亮界面", icon: <Sun className="h-4 w-4" /> },
    { value: "dark", label: "深色", desc: "护眼暗色", icon: <Moon className="h-4 w-4" /> },
    { value: "system", label: "跟随系统", desc: "自动适配系统主题", icon: <Monitor className="h-4 w-4" /> },
  ];

  return (
    <DashboardShell
      role={role}
      title="个人设置"
      subtitle="自定义你的界面主题，仅对当前浏览器生效。"
    >
      <Card>
        <CardHeader>
          <SectionTitle
            title="界面主题"
            description="选择界面显示风格与明暗模式，修改后立即生效并自动保存。"
          />
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--color-foreground)]">
              显示风格
            </label>
            <OptionGrid
              options={appearanceOptions}
              value={appearance}
              onChange={setAppearance}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--color-foreground)]">
              明暗模式
            </label>
            <OptionGrid
              options={modeOptions}
              value={mode}
              onChange={setMode}
            />
            <p className="text-xs text-[var(--color-foreground-muted)]">
              顶栏的快捷按钮只切换明暗模式；如需切换显示风格请回到本页。
            </p>
          </div>
        </CardContent>
      </Card>
    </DashboardShell>
  );
}

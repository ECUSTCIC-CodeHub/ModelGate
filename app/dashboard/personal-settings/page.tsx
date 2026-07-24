"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { useTheme } from "@/components/providers/theme-provider";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Monitor, Moon, Sun, Type } from "lucide-react";
import { authedFetch, ensureLoggedIn, getCachedProfile } from "@/lib/auth/client-auth";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/shared/api-message";

type Option<T> = {
  value: T;
  label: string;
  desc: string;
  icon: React.ReactNode;
};

function OptionGrid<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: Option<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {options.map((option) => {
        const active = !disabled && value !== undefined && option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            disabled={disabled}
            className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors ${
              active
                ? "border-[var(--color-accent)] bg-[var(--color-accent-muted)]"
                : "border-[var(--color-border)] hover:border-[var(--color-border-hover)] hover:bg-[var(--color-surface-hover)]"
            } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
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

type TriState = -1 | 0 | 1;

type GatewayPrefs = {
  model_fallback: TriState;
  vision_fallback: TriState;
  quota_fallback: TriState;
};

export default function PersonalSettingsPage() {
  const router = useRouter();
  const initialProfile = useAuthProfile();
  const { appearance, mode, setAppearance, setMode } = useTheme();
  const { toast } = useToast();
  const [role, setRole] = useState<"admin" | "user">(
    () => initialProfile?.role ?? getCachedProfile()?.role ?? "user",
  );
  const [prefs, setPrefs] = useState<GatewayPrefs>({
    model_fallback: -1,
    vision_fallback: -1,
    quota_fallback: -1,
  });
  const [defaults, setDefaults] = useState<GatewayPrefs>({
    model_fallback: -1,
    vision_fallback: -1,
    quota_fallback: -1,
  });
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [prefsLoadFailed, setPrefsLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const profile = await ensureLoggedIn(router);
        if (!profile) return;
        setRole(profile.role as "admin" | "user");
        const response = await authedFetch("/api/dashboard/personal-settings");
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          setPrefsLoadFailed(true);
          return;
        }
        const data = (payload as { preferences?: Partial<GatewayPrefs>; defaults?: Partial<Record<keyof GatewayPrefs, boolean>> }) ?? {};
        setPrefs({
          model_fallback: (data.preferences?.model_fallback ?? -1) as TriState,
          vision_fallback: (data.preferences?.vision_fallback ?? -1) as TriState,
          quota_fallback: (data.preferences?.quota_fallback ?? -1) as TriState,
        });
        setDefaults({
          model_fallback: (data.defaults?.model_fallback ? 1 : 0) as TriState,
          vision_fallback: (data.defaults?.vision_fallback ? 1 : 0) as TriState,
          quota_fallback: (data.defaults?.quota_fallback ? 1 : 0) as TriState,
        });
      } catch {
        if (!cancelled) setPrefsLoadFailed(true);
      } finally {
        if (!cancelled) setPrefsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [router]);

  async function updatePref(key: keyof GatewayPrefs, value: TriState) {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    const response = await authedFetch("/api/dashboard/personal-settings", {
      method: "PUT",
      body: JSON.stringify({ [key]: value }),
    });
    const data = await response.json().catch(() => null);
    toast({
      variant: response.ok ? "success" : "error",
      description: getApiMessage(data, response.ok ? "个人设置已保存。" : "保存失败。"),
    });
  }

  const gatewayReady = prefsLoaded && !prefsLoadFailed;

  const appearanceOptions: Option<"default" | "retro">[] = [
    { value: "default", label: "现代", desc: "当前默认界面风格", icon: <Monitor className="h-4 w-4" /> },
    { value: "retro", label: "复古", desc: "90 年代纯文本风格", icon: <Type className="h-4 w-4" /> },
  ];

  const modeOptions: Option<"light" | "dark" | "system">[] = [
    { value: "light", label: "浅色", desc: "明亮界面", icon: <Sun className="h-4 w-4" /> },
    { value: "dark", label: "深色", desc: "护眼暗色", icon: <Moon className="h-4 w-4" /> },
    { value: "system", label: "跟随系统", desc: "自动适配系统主题", icon: <Monitor className="h-4 w-4" /> },
  ];

  const triStateOptions = (defaultEnabled: boolean): Option<TriState>[] => [
    { value: -1, label: "继承全局", desc: `跟随全局（${defaultEnabled ? "已开启" : "已关闭"}）`, icon: <Monitor className="h-4 w-4" /> },
    { value: 1, label: "启用", desc: "强制开启", icon: <Sun className="h-4 w-4" /> },
    { value: 0, label: "禁用", desc: "强制关闭", icon: <Moon className="h-4 w-4" /> },
  ];

  return (
    <DashboardShell
      role={role}
      title="个人设置"
      subtitle="自定义界面主题与网关行为偏好，主题仅对当前浏览器生效，网关行为跟随你的账号。"
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

      <Card className="mt-4">
        <CardHeader>
          <SectionTitle
            title="网关行为"
            description="单独控制是否对你启用模型替补、图片自动路由、限额自动路由。选择「继承全局」则跟随管理员的系统设置。"
          />
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--color-foreground)]">
              模型不可用时自动替补
            </label>
            <OptionGrid
              options={triStateOptions(defaults.model_fallback === 1)}
              value={gatewayReady ? prefs.model_fallback : undefined}
              onChange={(v) => void updatePref("model_fallback", v)}
              disabled={!gatewayReady}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--color-foreground)]">
              图片自动路由到识图模型
            </label>
            <OptionGrid
              options={triStateOptions(defaults.vision_fallback === 1)}
              value={gatewayReady ? prefs.vision_fallback : undefined}
              onChange={(v) => void updatePref("vision_fallback", v)}
              disabled={!gatewayReady}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--color-foreground)]">
              达到限额后自动路由
            </label>
            <OptionGrid
              options={triStateOptions(defaults.quota_fallback === 1)}
              value={gatewayReady ? prefs.quota_fallback : undefined}
              onChange={(v) => void updatePref("quota_fallback", v)}
              disabled={!gatewayReady}
            />
            <p className="text-xs text-[var(--color-foreground-muted)]">
              模型独立配额超限时切换到其他模型；用户配额或速率超限时仅切换到不计入用户配额的模型。仅对话类协议生效。请求含图片时，候选模型必须支持识图以保证路由后仍可用，与「图片自动路由」开关互不影响。
            </p>
            {prefsLoadFailed ? (
              <p className="text-xs text-[var(--color-error)]">
                网关行为偏好加载失败，请刷新页面重试。
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </DashboardShell>
  );
}

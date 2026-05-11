"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import {
  ChevronRight,
  KeyRound,
  LayoutGrid,
  Link2,
  Link2Off,
  LockKeyhole,
  LogOut,
  Menu,
  Moon,
  RefreshCw,
  Settings2,
  Shield,
  Sparkles,
  Sun,
  UserCog,
  Users,
  Waypoints,
} from "lucide-react";
import { useAuthProfile, useOidcEnabled } from "@/components/providers/auth-provider";
import { useTheme } from "@/components/providers/theme-provider";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { authedFetch, clearCachedProfile, clearSession, getCachedProfile, getOrFetchProfile } from "@/lib/client-auth";
import { getApiMessage } from "@/lib/api-message";
import { cn } from "@/lib/utils";

type Role = "admin" | "user";

type DashboardShellProps = {
  role: Role;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
};

type ProfileBrief = {
  username: string;
  rpm: number;
  qps: number;
  tpm: number;
  quota_tokens: number | null;
  quota_requests: number | null;
  quota_period: number | null;
  period_quota_tokens: number | null;
  period_quota_requests: number | null;
  used_tokens?: number;
  used_requests?: number;
  period_used_tokens?: number;
  period_used_requests?: number;
  period_reset_at?: string | null;
  oidc_issuer?: string | null;
  oidc_subject?: string | null;
};

const adminMenus = [
  { href: "/dashboard", label: "首页概览", icon: LayoutGrid },
  { href: "/dashboard/logs", label: "请求日志", icon: Sparkles },
  { href: "/dashboard/channels", label: "渠道管理", icon: Waypoints },
  { href: "/dashboard/users", label: "用户管理", icon: UserCog },
  { href: "/dashboard/groups", label: "用户组管理", icon: Users },
  { href: "/dashboard/settings", label: "系统设置", icon: Settings2 },
  { href: "/dashboard/keys", label: "密钥管理", icon: KeyRound },
  { href: "/dashboard/models", label: "接入指南", icon: Shield },
];

const userMenus = [
  { href: "/dashboard", label: "首页概览", icon: LayoutGrid },
  { href: "/dashboard/logs", label: "请求日志", icon: Sparkles },
  { href: "/dashboard/keys", label: "密钥管理", icon: KeyRound },
  { href: "/dashboard/models", label: "接入指南", icon: Shield },
];

export function DashboardShell({ role, title, subtitle, right, children }: DashboardShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const initialProfile = useAuthProfile();
  const menus = role === "admin" ? adminMenus : userMenus;
  const { toast } = useToast();
  const { theme, toggle: toggleTheme } = useTheme();
  const [profileBrief, setProfileBrief] = useState<ProfileBrief | null>(() => initialProfile ?? getCachedProfile());
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [passwordDrawerOpen, setPasswordDrawerOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const oidcAvailable = useOidcEnabled();

  useEffect(() => {
    clearCachedProfile();
    void getOrFetchProfile().then((next) => {
      if (next) setProfileBrief(next);
    });
  }, []);

  function onLogout() {
    void fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).finally(() => {
      clearSession();
      router.replace("/login");
    });
  }

  function onNavigateMobile() {
    setMobileNavOpen(false);
  }

  function formatLimit(value: number | null | undefined) {
    if (value === null || value === undefined) return "-";
    if (value < 0) return "∞";
    const abs = Math.abs(value);
    if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return String(value);
  }

  function periodExpired(resetAt: string | null | undefined): boolean {
    if (!resetAt) return false;
    return new Date(resetAt) <= new Date();
  }

  function periodLabel(seconds: number | null | undefined) {
    if (!seconds || seconds <= 0) return "";
    if (seconds === 3600) return "每小时";
    if (seconds === 86400) return "每日";
    if (seconds === 604800) return "每周";
    if (seconds === 2592000) return "每月";
    if (seconds >= 86400) return `每${Math.round(seconds / 86400)}天`;
    if (seconds >= 3600) return `每${Math.round(seconds / 3600)}时`;
    return `每${seconds}秒`;
  }

  function onOidcBind() {
    window.location.href = "/api/auth/oidc/bind";
  }

  function onOidcSync() {
    window.location.href = "/api/auth/oidc/bind";
  }

  async function onOidcUnbind() {
    const response = await authedFetch("/api/auth/oidc/unbind", { method: "POST" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "OIDC 绑定已解除。") });
      clearCachedProfile();
      void getOrFetchProfile().then((next) => { if (next) setProfileBrief(next); });
    } else {
      toast({ variant: "error", description: getApiMessage(data, "解除绑定失败。") });
    }
  }

  async function onChangePassword() {
    const response = await authedFetch("/api/dashboard/profile/password", {
      method: "PUT",
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      toast({ variant: "error", description: getApiMessage(data, "密码修改失败。") });
      return;
    }
    toast({ variant: "success", description: getApiMessage(data, "密码修改成功。") });
    setCurrentPassword("");
    setNewPassword("");
    setPasswordDrawerOpen(false);
  }

  return (
    <main className="min-h-screen text-[var(--color-foreground)]">
      <div className="flex min-h-screen gap-4 px-3 py-4 lg:gap-6 lg:px-6">
        {/* Sidebar */}
        <aside className="hidden w-60 shrink-0 lg:block">
          <div className="sticky top-4 flex h-[calc(100vh-2rem)] flex-col rounded-xl border border-[var(--color-sidebar-border)] bg-[var(--color-sidebar-bg)] p-4 shadow-[var(--shadow-md)]">
            <div className="space-y-4">
              <div className="flex items-center gap-3 px-1 py-2">
                <Image
                  src="/logo/TDP.svg"
                  alt="TDP Logo"
                  width={36}
                  height={36}
                  priority
                  className="shrink-0"
                />
                <div className="min-w-0">
                  <p className="font-mono text-sm font-semibold text-[var(--color-foreground)]">ModelGate</p>
                  <p className="mt-0.5 text-xs text-[var(--color-foreground-muted)]">模型网关管理控制台</p>
                </div>
              </div>
              <Separator />
            </div>
            <ScrollArea className="mt-4 flex-1">
              <nav className="space-y-1 pr-3">
                {menus.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-200",
                        active
                          ? "bg-[var(--color-sidebar-active-bg)] text-[var(--color-sidebar-active-text)] shadow-sm"
                          : "text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover)] hover:text-[var(--color-foreground)]",
                      )}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      <span className="flex-1">{item.label}</span>
                      {active ? <ChevronRight className="h-4 w-4 opacity-60" /> : null}
                    </Link>
                  );
                })}
              </nav>
            </ScrollArea>

            {profileBrief ? (
              <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[var(--color-foreground)]">{profileBrief.username}</p>
                </div>
                <div className="space-y-1.5 rounded-lg bg-[var(--color-bg)]/30 px-3 py-2 tabular-nums">
                  {([
                    ["RPM", formatLimit(profileBrief.rpm)],
                    ["QPS", formatLimit(profileBrief.qps)],
                    ["TPM", formatLimit(profileBrief.tpm)],
                  ] as const).map(([label, value]) => (
                    <div key={label} className="flex items-baseline justify-between">
                      <span className="text-[10px] uppercase tracking-wide text-[var(--color-foreground-muted)]">{label}</span>
                      <span className="font-mono text-sm text-[var(--color-foreground)]">{value}</span>
                    </div>
                  ))}
                  {([
                    profileBrief.quota_requests !== null && profileBrief.quota_requests !== undefined
                      ? ["总请求", profileBrief.used_requests ?? 0, profileBrief.quota_requests] as const
                      : null,
                    profileBrief.quota_tokens !== null && profileBrief.quota_tokens !== undefined
                      ? ["总Token", profileBrief.used_tokens ?? 0, profileBrief.quota_tokens] as const
                      : null,
                    profileBrief.quota_period && profileBrief.period_quota_requests !== null && profileBrief.period_quota_requests !== undefined
                      ? [`${periodLabel(profileBrief.quota_period)}请求`, periodExpired(profileBrief.period_reset_at) ? 0 : (profileBrief.period_used_requests ?? 0), profileBrief.period_quota_requests] as const
                      : null,
                    profileBrief.quota_period && profileBrief.period_quota_tokens !== null && profileBrief.period_quota_tokens !== undefined
                      ? [`${periodLabel(profileBrief.quota_period)}Token`, periodExpired(profileBrief.period_reset_at) ? 0 : (profileBrief.period_used_tokens ?? 0), profileBrief.period_quota_tokens] as const
                      : null,
                  ]).filter(Boolean).map((item) => {
                    const [label, used, total] = item!;
                    const remaining = Math.max(0, total - used);
                    return (
                      <div key={label} className="mt-0.5">
                        <span className="text-[10px] tracking-wide text-[var(--color-foreground-muted)]">{label}</span>
                        <div className="flex justify-end font-mono text-sm text-[var(--color-foreground)]">
                          <span>{formatLimit(remaining)}</span>
                          <span className="text-[var(--color-foreground-muted)]"> / {formatLimit(total)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={() => setPasswordDrawerOpen(true)}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-[var(--color-foreground-muted)] transition-colors duration-200 hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)]"
                  >
                    <LockKeyhole className="h-4 w-4 shrink-0" />
                    <span className="flex-1 text-left">修改密码</span>
                  </button>
                  {oidcAvailable ? (
                    profileBrief.oidc_subject ? (
                      <>
                        <button
                          type="button"
                          onClick={onOidcSync}
                          className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-[var(--color-foreground-muted)] transition-colors duration-200 hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)]"
                        >
                          <RefreshCw className="h-4 w-4 shrink-0" />
                          <span className="flex-1 text-left">同步 OIDC</span>
                          <span className="text-[10px] text-[var(--color-accent)]">已绑定</span>
                        </button>
                        <button
                          type="button"
                          onClick={onOidcUnbind}
                          className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-[var(--color-foreground-muted)] transition-colors duration-200 hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)]"
                        >
                          <Link2Off className="h-4 w-4 shrink-0" />
                          <span className="flex-1 text-left">解绑 OIDC</span>
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={onOidcBind}
                        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-[var(--color-foreground-muted)] transition-colors duration-200 hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)]"
                      >
                        <Link2 className="h-4 w-4 shrink-0" />
                        <span className="flex-1 text-left">绑定 OIDC</span>
                        <span className="text-[10px] text-[var(--color-foreground-subtle)]">未绑定</span>
                      </button>
                    )
                  ) : null}
                  <button
                    type="button"
                    onClick={onLogout}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors duration-200 hover:bg-red-500/10 text-rose-500 hover:text-rose-400"
                  >
                    <LogOut className="h-4 w-4 shrink-0" />
                    <span className="flex-1 text-left">退出登录</span>
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </aside>

        {/* Main Content */}
        <section className="flex min-w-0 flex-1 flex-col gap-4">
          <header className="sticky top-4 z-20 rounded-xl border border-[var(--color-header-border)] bg-[var(--color-header-bg)] px-4 py-3 shadow-[var(--shadow-md)] lg:px-6 lg:py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="hidden items-center gap-1.5 text-xs text-[var(--color-foreground-muted)] lg:flex">
                  <span>Dashboard</span>
                  <span>/</span>
                  <span className="truncate text-[var(--color-foreground-secondary)]">{title}</span>
                </div>
                <h1 className="font-mono text-lg font-semibold tracking-tight text-[var(--color-foreground)] lg:mt-1 lg:text-2xl">{title}</h1>
                {subtitle ? <p className="mt-1 hidden max-w-3xl text-sm text-[var(--color-foreground-muted)] lg:block">{subtitle}</p> : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {right ? <div className="hidden items-center gap-2 sm:flex">{right}</div> : null}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={toggleTheme}
                        aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
                      >
                        {theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <Button variant="outline" size="icon" className="lg:hidden" onClick={() => setMobileNavOpen(true)}>
                  <Menu className="h-4 w-4" />
                  <span className="sr-only">打开菜单</span>
                </Button>
              </div>
            </div>
          </header>

          <div className="min-h-0 flex-1">{children}</div>
        </section>
      </div>

      {/* Mobile Nav Sheet */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-[320px] p-0">
          <SheetHeader className="border-b border-[var(--color-border)] px-5 py-4">
            <div className="flex items-center gap-3">
              <Image
                src="/logo/TDP.svg"
                alt="TDP Logo"
                width={32}
                height={32}
                className="shrink-0"
              />
              <div className="min-w-0">
                <SheetTitle>后台导航</SheetTitle>
                <SheetDescription>快速切换页面与管理账号。</SheetDescription>
              </div>
            </div>
          </SheetHeader>
          <div className="flex h-full flex-col">
            <ScrollArea className="flex-1 px-4 py-4">
              <div className="space-y-1">
                {menus.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={onNavigateMobile}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-200",
                        active
                          ? "bg-[var(--color-sidebar-active-bg)] text-[var(--color-sidebar-active-text)]"
                          : "text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)]",
                      )}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </ScrollArea>
            <Separator />
            <div className="space-y-3 p-4">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  toggleTheme();
                }}
              >
                {theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                {theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
              </Button>
              {profileBrief ? (
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
                  <p className="truncate text-sm font-semibold text-[var(--color-foreground)]">{profileBrief.username}</p>
                  <p className="mt-1 text-xs text-[var(--color-foreground-muted)]">RPM {formatLimit(profileBrief.rpm)} / QPS {formatLimit(profileBrief.qps)} / TPM {formatLimit(profileBrief.tpm)}</p>
                  {profileBrief.quota_requests !== null || profileBrief.quota_tokens !== null ? (
                    <p className="mt-1 text-xs text-[var(--color-foreground-muted)]">
                      配额: 请求 {formatLimit(profileBrief.used_requests ?? 0)}/{formatLimit(profileBrief.quota_requests)} / Token {formatLimit(profileBrief.used_tokens ?? 0)}/{formatLimit(profileBrief.quota_tokens)}
                    </p>
                  ) : null}
                  {profileBrief.quota_period ? (
                    <p className="mt-1 text-xs text-[var(--color-foreground-muted)]">
                      {periodLabel(profileBrief.quota_period)}: 请求 {formatLimit(periodExpired(profileBrief.period_reset_at) ? 0 : (profileBrief.period_used_requests ?? 0))}/{formatLimit(profileBrief.period_quota_requests)} / Token {formatLimit(periodExpired(profileBrief.period_reset_at) ? 0 : (profileBrief.period_used_tokens ?? 0))}/{formatLimit(profileBrief.period_quota_tokens)}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  setMobileNavOpen(false);
                  setPasswordDrawerOpen(true);
                }}
              >
                修改密码
              </Button>
              {oidcAvailable ? (
                profileBrief?.oidc_subject ? (
                  <>
                    <Button variant="outline" className="w-full" onClick={() => { setMobileNavOpen(false); onOidcSync(); }}>
                      同步 OIDC
                    </Button>
                    <Button variant="outline" className="w-full" onClick={() => { setMobileNavOpen(false); onOidcUnbind(); }}>
                      解绑 OIDC
                    </Button>
                  </>
                ) : (
                  <Button variant="outline" className="w-full" onClick={() => { setMobileNavOpen(false); onOidcBind(); }}>
                    绑定 OIDC
                  </Button>
                )
              ) : null}
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => {
                  setMobileNavOpen(false);
                  onLogout();
                }}
              >
                <LogOut className="h-4 w-4" />
                退出登录
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Password Change Dialog */}
      <Dialog open={passwordDrawerOpen} onOpenChange={setPasswordDrawerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>修改密码</DialogTitle>
            <DialogDescription>更新当前账号密码，不会影响现有 Token 与权限配置。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="shell_current_password">当前密码</Label>
              <Input
                id="shell_current_password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="shell_new_password">新密码</Label>
              <Input
                id="shell_new_password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasswordDrawerOpen(false)}>取消</Button>
            <Button onClick={onChangePassword}>更新密码</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

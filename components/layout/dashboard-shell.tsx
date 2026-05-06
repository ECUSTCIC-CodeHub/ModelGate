"use client";

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
  Settings2,
  Shield,
  Sparkles,
  UserCog,
  Users,
  Waypoints,
} from "lucide-react";
import { useAuthProfile, useOidcEnabled } from "@/components/providers/auth-provider";
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

  function onOidcBind() {
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
    <main className="min-h-screen bg-transparent text-zinc-100">
      <div className="flex min-h-screen gap-4 px-3 py-4 lg:gap-6 lg:px-6">
        <aside className="hidden w-60 shrink-0 lg:block">
          <div className="sticky top-4 flex h-[calc(100vh-2rem)] flex-col rounded-xl border border-white/10 bg-[rgba(15,23,42,0.82)] p-4 shadow-xl backdrop-blur">
            <div className="space-y-4">
              <div className="px-1 py-2">
                <p className="text-sm font-semibold text-zinc-100">ModelGate</p>
                <p className="mt-0.5 text-xs text-zinc-500">模型网关管理控制台</p>
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
                        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-zinc-300 transition-colors",
                        active ? "bg-white/10 text-white" : "hover:bg-white/6 hover:text-white",
                      )}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      <span className="flex-1">{item.label}</span>
                      {active ? <ChevronRight className="h-4 w-4 text-zinc-500" /> : null}
                    </Link>
                  );
                })}
              </nav>
            </ScrollArea>
            {profileBrief ? (
              <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-zinc-100">{profileBrief.username}</p>
                  <p className="mt-0.5 truncate text-xs text-zinc-400">{role === "admin" ? "管理员" : "普通用户"}</p>
                </div>
                <div className="grid grid-cols-3 gap-2 rounded-lg bg-black/20 px-2 py-2 text-center">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-zinc-500">RPM</p>
                    <p className="mt-0.5 truncate font-mono text-sm text-zinc-100">{formatLimit(profileBrief.rpm)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-zinc-500">QPS</p>
                    <p className="mt-0.5 truncate font-mono text-sm text-zinc-100">{formatLimit(profileBrief.qps)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-zinc-500">TPM</p>
                    <p className="mt-0.5 truncate font-mono text-sm text-zinc-100">{formatLimit(profileBrief.tpm)}</p>
                  </div>
                </div>
                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={() => setPasswordDrawerOpen(true)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    <LockKeyhole className="h-4 w-4 shrink-0" />
                    <span className="flex-1 text-left">修改密码</span>
                  </button>
                  {oidcAvailable ? (
                    profileBrief.oidc_subject ? (
                      <button
                        type="button"
                        onClick={onOidcUnbind}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
                      >
                        <Link2Off className="h-4 w-4 shrink-0" />
                        <span className="flex-1 text-left">解绑 OIDC</span>
                        <span className="text-[10px] text-emerald-400">已绑定</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={onOidcBind}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
                      >
                        <Link2 className="h-4 w-4 shrink-0" />
                        <span className="flex-1 text-left">绑定 OIDC</span>
                        <span className="text-[10px] text-zinc-500">未绑定</span>
                      </button>
                    )
                  ) : null}
                  <button
                    type="button"
                    onClick={onLogout}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-rose-300 transition-colors hover:bg-rose-500/10 hover:text-rose-200"
                  >
                    <LogOut className="h-4 w-4 shrink-0" />
                    <span className="flex-1 text-left">退出登录</span>
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col gap-4">
          <header className="sticky top-4 z-20 rounded-xl border border-white/10 bg-[rgba(15,23,42,0.82)] px-4 py-3 shadow-xl backdrop-blur lg:px-6 lg:py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="hidden items-center gap-1.5 text-xs text-zinc-500 lg:flex">
                  <span>Dashboard</span>
                  <span>/</span>
                  <span className="truncate text-zinc-400">{title}</span>
                </div>
                <h1 className="text-lg font-semibold tracking-tight text-zinc-50 lg:mt-1 lg:text-2xl">{title}</h1>
                {subtitle ? <p className="mt-1 hidden max-w-3xl text-sm text-zinc-400 lg:block">{subtitle}</p> : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {right ? <div className="hidden items-center gap-2 sm:flex">{right}</div> : null}
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

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-[320px] p-0">
          <SheetHeader className="border-b border-white/10 px-5 py-4">
            <SheetTitle>后台导航</SheetTitle>
            <SheetDescription>保持原有路由结构，统一为 shadcn 风格交互。</SheetDescription>
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
                        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-zinc-300 transition-colors",
                        active ? "bg-white/10 text-white" : "hover:bg-white/6 hover:text-white",
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
              {profileBrief ? (
                <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <p className="truncate text-sm font-semibold text-zinc-100">{profileBrief.username}</p>
                  <p className="mt-1 text-xs text-zinc-400">RPM {formatLimit(profileBrief.rpm)} / QPS {formatLimit(profileBrief.qps)} / TPM {formatLimit(profileBrief.tpm)}</p>
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
                  <Button variant="outline" className="w-full" onClick={() => { setMobileNavOpen(false); onOidcUnbind(); }}>
                    解绑 OIDC
                  </Button>
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

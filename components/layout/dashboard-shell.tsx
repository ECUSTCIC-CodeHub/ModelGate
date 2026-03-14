"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { KeyRound, LayoutGrid, LogOut, Menu, PanelLeftClose, Settings2, Shield, Sparkles, UserCog, Waypoints } from "lucide-react";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SideDrawer } from "@/components/ui/side-drawer";
import { useToast } from "@/components/ui/toast";
import { authedFetch, clearSession, getCachedProfile, getOrFetchProfile } from "@/lib/client-auth";
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
};

const adminMenus = [
  { href: "/dashboard", label: "首页", icon: LayoutGrid },
  { href: "/dashboard/logs", label: "请求日志", icon: Sparkles },
  { href: "/dashboard/channels", label: "渠道管理", icon: Waypoints },
  { href: "/dashboard/users", label: "用户管理", icon: UserCog },
  { href: "/dashboard/settings", label: "系统设置", icon: Settings2 },
  { href: "/dashboard/keys", label: "我的 Key", icon: KeyRound },
  { href: "/dashboard/models", label: "可用模型", icon: Shield },
];

const userMenus = [
  { href: "/dashboard", label: "首页", icon: LayoutGrid },
  { href: "/dashboard/logs", label: "请求日志", icon: Sparkles },
  { href: "/dashboard/keys", label: "我的 Key", icon: KeyRound },
  { href: "/dashboard/models", label: "可用模型", icon: Shield },
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

  useEffect(() => {
    if (profileBrief) return;
    void getOrFetchProfile().then((next) => {
      if (next) setProfileBrief(next);
    });
  }, [profileBrief]);

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
    return String(value);
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
    <main className="relative min-h-screen text-zinc-100 md:h-screen md:overflow-hidden">
      <div className="safe-pad-bottom flex min-h-screen w-full gap-3 px-3 py-3 sm:px-4 md:h-full md:gap-4 md:py-4 xl:px-6">
        <aside className="glass-panel sticky top-4 hidden h-[calc(100vh-2rem)] w-72 shrink-0 overflow-hidden rounded-[28px] p-4 md:flex md:flex-col">
          <div className="mb-5 rounded-2xl border border-white/8 bg-white/[0.04] p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#a6f1de_0%,#7ee0d2_100%)] text-slate-950 shadow-lg shadow-emerald-400/20">
                <PanelLeftClose className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-zinc-100">控制台</p>
                <p className="mt-1 text-xs text-zinc-400">模型网关管理</p>
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <nav className="space-y-2">
              {menus.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-2xl border px-3 py-3 text-sm transition-colors",
                    pathname === item.href
                      ? "border-[rgba(159,232,216,0.2)] bg-[rgba(159,232,216,0.08)] text-white shadow-[0_10px_24px_rgba(126,224,210,0.08)]"
                      : "border-transparent text-zinc-300 hover:border-white/8 hover:bg-white/[0.04] hover:text-white",
                  )}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          {profileBrief ? (
            <div className="mb-3 rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-4 text-xs text-zinc-300">
              <p className="truncate text-base font-medium text-zinc-100">{profileBrief.username}</p>
              <p className="mt-1 text-[11px] tracking-[0.2em] text-zinc-500 uppercase">{role === "admin" ? "Administrator" : "Workspace User"}</p>
              <div className="mt-4 grid grid-cols-3 gap-2">
                <div className="rounded-xl bg-black/30 p-2.5">
                  <span className="text-[10px] tracking-[0.18em] text-zinc-500 uppercase">RPM</span>
                  <p className="mt-1 text-right text-sm font-semibold text-zinc-100">{formatLimit(profileBrief.rpm)}</p>
                </div>
                <div className="rounded-xl bg-black/30 p-2.5">
                  <span className="text-[10px] tracking-[0.18em] text-zinc-500 uppercase">QPS</span>
                  <p className="mt-1 text-right text-sm font-semibold text-zinc-100">{formatLimit(profileBrief.qps)}</p>
                </div>
                <div className="rounded-xl bg-black/30 p-2.5">
                  <span className="text-[10px] tracking-[0.18em] text-zinc-500 uppercase">TPM</span>
                  <p className="mt-1 text-right text-sm font-semibold text-zinc-100">{formatLimit(profileBrief.tpm)}</p>
                </div>
              </div>
            </div>
          ) : null}
          <Button
            variant="outline"
            className="mb-2 w-full justify-center"
            onClick={() => setPasswordDrawerOpen(true)}
          >
            修改密码
          </Button>
          <Button variant="secondary" className="mt-2 w-full justify-center" onClick={onLogout}>
            <LogOut className="h-4 w-4" />
            退出登录
          </Button>
        </aside>

        <section className="min-w-0 flex-1 md:overflow-hidden">
          <div className="flex min-h-full flex-col md:h-full md:min-h-0">
            <header
              className={cn(
                "glass-panel mb-3 shrink-0 rounded-[24px] p-4 sm:mb-4 sm:p-5",
                !right ? "md:hidden" : "",
              )}
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="max-w-3xl">
                  <div className="flex items-center justify-between gap-3 md:block">
                    <p className="text-xs font-semibold tracking-[0.26em] text-[var(--accent)] uppercase">Control Center</p>
                    <Button variant="outline" size="sm" className="md:hidden" onClick={() => setMobileNavOpen(true)}>
                      <Menu className="h-4 w-4" />
                      菜单
                    </Button>
                  </div>
                  <h1 className="surface-title mt-3 text-3xl font-semibold tracking-[-0.04em] text-white">{title}</h1>
                  {subtitle ? <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--muted)]">{subtitle}</p> : null}
                </div>
                {right ? (
                  <div className="flex items-center gap-2">{right}</div>
                ) : null}
              </div>
            </header>
            <div className="min-h-0 flex-1 pr-0 md:overflow-hidden md:pr-1">
              {children}
            </div>
          </div>
        </section>
      </div>
      <SideDrawer
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        title="导航菜单"
        className="max-w-md border-l-white/10 bg-[rgba(6,12,23,0.98)]"
      >
        <div className="space-y-4">
          {profileBrief ? (
            <div className="rounded-[20px] border border-white/8 bg-white/[0.04] p-4 text-xs text-zinc-300">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-medium text-zinc-100">{profileBrief.username}</p>
                  <p className="mt-1 text-[11px] tracking-[0.2em] text-zinc-500 uppercase">{role === "admin" ? "Administrator" : "Workspace User"}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setMobileNavOpen(false);
                    setPasswordDrawerOpen(true);
                  }}
                >
                  修改密码
                </Button>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2">
                <div className="rounded-xl bg-black/30 p-2.5">
                  <span className="text-[10px] tracking-[0.18em] text-zinc-500 uppercase">RPM</span>
                  <p className="mt-1 text-right text-sm font-semibold text-zinc-100">{formatLimit(profileBrief.rpm)}</p>
                </div>
                <div className="rounded-xl bg-black/30 p-2.5">
                  <span className="text-[10px] tracking-[0.18em] text-zinc-500 uppercase">QPS</span>
                  <p className="mt-1 text-right text-sm font-semibold text-zinc-100">{formatLimit(profileBrief.qps)}</p>
                </div>
                <div className="rounded-xl bg-black/30 p-2.5">
                  <span className="text-[10px] tracking-[0.18em] text-zinc-500 uppercase">TPM</span>
                  <p className="mt-1 text-right text-sm font-semibold text-zinc-100">{formatLimit(profileBrief.tpm)}</p>
                </div>
              </div>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-2">
            {menus.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigateMobile}
                className={cn(
                  "inline-flex min-h-12 items-center gap-3 rounded-2xl border px-4 py-3 text-sm transition-colors",
                  pathname === item.href
                    ? "border-[rgba(159,232,216,0.2)] bg-[rgba(159,232,216,0.08)] text-white"
                    : "border-white/8 bg-white/[0.04] text-zinc-300",
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            ))}
            <Button
              variant="secondary"
              className="min-h-12 justify-center"
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
      </SideDrawer>
      <SideDrawer
        open={passwordDrawerOpen}
        onClose={() => setPasswordDrawerOpen(false)}
        title="修改密码"
      >
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
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setPasswordDrawerOpen(false)}>取消</Button>
            <Button onClick={onChangePassword}>更新密码</Button>
          </div>
        </div>
      </SideDrawer>
    </main>
  );
}

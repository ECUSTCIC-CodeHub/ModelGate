"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SideDrawer } from "@/components/ui/side-drawer";
import { useToast } from "@/components/ui/toast";
import { authedFetch, clearSession } from "@/lib/client-auth";
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
  { href: "/dashboard", label: "首页" },
  { href: "/dashboard/logs", label: "请求日志" },
  { href: "/dashboard/channels", label: "渠道管理" },
  { href: "/dashboard/users", label: "用户管理" },
  { href: "/dashboard/settings", label: "系统设置" },
  { href: "/dashboard/keys", label: "我的 Key" },
];

const userMenus = [
  { href: "/dashboard", label: "首页" },
  { href: "/dashboard/logs", label: "请求日志" },
  { href: "/dashboard/keys", label: "我的 Key" },
];

export function DashboardShell({ role, right, children }: DashboardShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const menus = role === "admin" ? adminMenus : userMenus;
  const { toast } = useToast();
  const [profileBrief, setProfileBrief] = useState<ProfileBrief | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = sessionStorage.getItem("vlm-profile-brief");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { ts: number; data: ProfileBrief };
      if (Date.now() - parsed.ts < 60_000) return parsed.data;
    } catch {
      return null;
    }
    return null;
  });
  const [passwordDrawerOpen, setPasswordDrawerOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  useEffect(() => {
    const cacheKey = "vlm-profile-brief";
    if (profileBrief) return;

    void authedFetch("/api/dashboard/profile")
      .then(async (resp) => {
        if (!resp.ok) return;
        const data = await resp.json();
        const next = data?.user as ProfileBrief | undefined;
        if (!next) return;
        setProfileBrief(next);
        if (typeof window !== "undefined") {
          sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: next }));
        }
      })
      .catch(() => {});
  }, [profileBrief]);

  function onLogout() {
    if (typeof window !== "undefined") {
      sessionStorage.removeItem("vlm-profile-brief");
    }
    clearSession();
    router.push("/login");
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
    <main className="h-screen overflow-hidden bg-black text-zinc-100">
      <div className="flex h-full w-full gap-4 px-4 py-4 xl:px-6">
        <aside className="sticky top-4 hidden h-[calc(100vh-2rem)] w-60 shrink-0 rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 shadow-sm md:flex md:flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <nav className="space-y-1">
              {menus.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "block rounded-md px-3 py-2 text-sm",
                    pathname === item.href
                      ? "bg-zinc-100 text-zinc-900"
                      : "text-zinc-300 hover:bg-zinc-900",
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          {profileBrief ? (
            <div className="mb-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300">
              <p className="font-medium text-zinc-100">{profileBrief.username}</p>
              <p className="mt-1">RPM: {formatLimit(profileBrief.rpm)}</p>
              <p>QPS: {formatLimit(profileBrief.qps)}</p>
              <p>TPM: {formatLimit(profileBrief.tpm)}</p>
            </div>
          ) : null}
          <Button
            variant="outline"
            className="mb-2 w-full border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800"
            onClick={() => setPasswordDrawerOpen(true)}
          >
            修改密码
          </Button>
          <Button variant="secondary" className="mt-4 w-full bg-zinc-800 text-zinc-100 hover:bg-zinc-700" onClick={onLogout}>
            退出登录
          </Button>
        </aside>

        <section className="min-w-0 flex-1 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col">
          <header className={cn(
            "mb-4 shrink-0 rounded-2xl border border-zinc-800 bg-zinc-950/80 p-5 shadow-sm",
            !right ? "md:hidden" : "",
          )}>
            {right ? (
              <div className="flex items-start justify-end gap-3">
                <div className="flex items-center gap-2">{right}</div>
              </div>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2 md:hidden">
              {menus.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "rounded-md border px-3 py-1 text-sm",
                    pathname === item.href
                      ? "border-zinc-200 bg-zinc-100 text-zinc-900"
                      : "border-zinc-700 bg-zinc-900 text-zinc-300",
                  )}
                >
                  {item.label}
                </Link>
              ))}
              <Button variant="secondary" size="sm" className="bg-zinc-800 text-zinc-100 hover:bg-zinc-700" onClick={onLogout}>退出登录</Button>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden pr-1">
            {children}
          </div>
          </div>
        </section>
      </div>
      <SideDrawer
        open={passwordDrawerOpen}
        onClose={() => setPasswordDrawerOpen(false)}
        title="修改密码"
        description="建议使用至少 8 位，并包含字母与数字。"
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

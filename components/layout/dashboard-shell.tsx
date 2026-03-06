"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { clearSession } from "@/lib/client-auth";
import { cn } from "@/lib/utils";

type Role = "admin" | "user";

type DashboardShellProps = {
  role: Role;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
};

const adminMenus = [
  { href: "/dashboard", label: "控制台首页" },
  { href: "/dashboard/logs", label: "日志看板" },
  { href: "/dashboard/channels", label: "渠道管理" },
  { href: "/dashboard/users", label: "用户管理" },
  { href: "/dashboard/settings", label: "系统设置" },
  { href: "/dashboard/keys", label: "我的 Key" },
  { href: "/dashboard/profile", label: "个人资料" },
];

const userMenus = [
  { href: "/dashboard", label: "控制台首页" },
  { href: "/dashboard/logs", label: "日志看板" },
  { href: "/dashboard/keys", label: "我的 Key" },
  { href: "/dashboard/profile", label: "个人资料" },
];

export function DashboardShell({ role, right, children }: DashboardShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const menus = role === "admin" ? adminMenus : userMenus;

  function onLogout() {
    clearSession();
    router.push("/login");
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
    </main>
  );
}

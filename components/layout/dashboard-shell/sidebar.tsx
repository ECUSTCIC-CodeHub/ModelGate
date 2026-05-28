"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { DesktopProfileCard } from "@/components/layout/dashboard-shell/profile-card";
import type { DashboardMenuItem, ProfileBrief } from "@/components/layout/dashboard-shell/types";
import { cn } from "@/lib/shared/utils";

type DashboardSidebarProps = {
  menus: DashboardMenuItem[];
  pathname: string;
  profile: ProfileBrief | null;
  oidcAvailable: boolean;
  onChangePassword: () => void;
  onOidcBind: () => void;
  onOidcSync: () => void;
  onOidcUnbind: () => void;
  onLogout: () => void;
};

export function DashboardSidebar({
  menus,
  pathname,
  profile,
  oidcAvailable,
  onChangePassword,
  onOidcBind,
  onOidcSync,
  onOidcUnbind,
  onLogout,
}: DashboardSidebarProps) {
  return (
    <aside className="hidden w-64 shrink-0 lg:block">
      <div className="sticky top-3 flex h-[calc(100vh-1.5rem)] flex-col rounded-lg border border-[var(--color-sidebar-border)] bg-[var(--color-sidebar-bg)] p-3 shadow-[var(--shadow-sm)]">
        <div className="space-y-4">
          <div className="flex items-center gap-3 px-1 py-2">
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
                    "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors duration-150",
                    active
                      ? "bg-[var(--color-sidebar-active-bg)] text-[var(--color-sidebar-active-text)]"
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

        {profile ? (
          <DesktopProfileCard
            profile={profile}
            oidcAvailable={oidcAvailable}
            onChangePassword={onChangePassword}
            onOidcBind={onOidcBind}
            onOidcSync={onOidcSync}
            onOidcUnbind={onOidcUnbind}
            onLogout={onLogout}
          />
        ) : null}
      </div>
    </aside>
  );
}

"use client";

import Link from "next/link";
import { ChevronRight, MessageSquare } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { DesktopProfileCard } from "@/components/layout/dashboard-shell/profile-card";
import { useBranding } from "@/components/providers/branding-provider";
import type { DashboardMenuItem, ProfileBrief } from "@/components/layout/dashboard-shell/types";
import { cn } from "@/lib/shared/utils";

type DashboardSidebarProps = {
  menus: DashboardMenuItem[];
  feedbackUrl: string;
  pathname: string;
  profile: ProfileBrief | null;
  oidcAvailable: boolean;
  passwordLoginEnabled: boolean;
  onChangePassword: () => void;
  onOidcBind: () => void;
  onOidcSync: () => void;
  onOidcUnbind: () => void;
  onTotpManage: () => void;
  onLogout: () => void;
};

export function DashboardSidebar({
  menus,
  feedbackUrl,
  pathname,
  profile,
  oidcAvailable,
  passwordLoginEnabled,
  onChangePassword,
  onOidcBind,
  onOidcSync,
  onOidcUnbind,
  onTotpManage,
  onLogout,
}: DashboardSidebarProps) {
  const { logoUrl, logoSquareUrl } = useBranding();
  const logoSrc = logoUrl || logoSquareUrl;

  return (
    <aside className="hidden w-64 shrink-0 lg:block">
      <div className="sticky top-3 flex h-[calc(100vh-1.5rem)] flex-col rounded-lg border border-[var(--color-sidebar-border)] bg-[var(--color-sidebar-bg)] p-3 shadow-[var(--shadow-sm)]">
        <div className={logoSrc ? "space-y-2" : "space-y-4"}>
          <div className={`flex items-center gap-3 px-1 ${logoSrc ? "py-1.5" : "py-2"}`}>
            {logoSrc ? (
              <div className="min-w-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logoSrc} alt="Logo" className="h-10 w-auto object-contain" />
              </div>
            ) : (
              <div className="min-w-0">
                <p className="font-mono text-sm font-semibold text-[var(--color-foreground)]">ModelGate</p>
                <p className="mt-0.5 text-xs text-[var(--color-foreground-muted)]">模型网关管理控制台</p>
              </div>
            )}
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
            {feedbackUrl ? (
              <a
                href={feedbackUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-sm text-[var(--color-sidebar-text)] transition-colors duration-150 hover:bg-[var(--color-sidebar-hover)] hover:text-[var(--color-foreground)]"
              >
                <MessageSquare className="h-4 w-4 shrink-0" />
                <span className="flex-1">问题反馈</span>
              </a>
            ) : null}
          </nav>
        </ScrollArea>

        {profile ? (
          <DesktopProfileCard
            profile={profile}
            oidcAvailable={oidcAvailable}
            passwordLoginEnabled={passwordLoginEnabled}
            onChangePassword={onChangePassword}
            onOidcBind={onOidcBind}
            onOidcSync={onOidcSync}
            onOidcUnbind={onOidcUnbind}
            onTotpManage={onTotpManage}
            onLogout={onLogout}
          />
        ) : null}
      </div>
    </aside>
  );
}

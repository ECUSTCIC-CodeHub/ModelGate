"use client";

import Link from "next/link";
import { LogOut, MessageSquare, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { MobileProfileSummary } from "@/components/layout/dashboard-shell/profile-card";
import type { DashboardMenuItem, ProfileBrief } from "@/components/layout/dashboard-shell/types";
import { cn } from "@/lib/shared/utils";

type MobileNavSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  menus: DashboardMenuItem[];
  feedbackUrl: string;
  pathname: string;
  profile: ProfileBrief | null;
  oidcAvailable: boolean;
  passwordLoginEnabled: boolean;
  theme: string;
  onToggleTheme: () => void;
  onChangePassword: () => void;
  onOidcBind: () => void;
  onOidcSync: () => void;
  onOidcUnbind: () => void;
  onLogout: () => void;
};

export function MobileNavSheet({
  open,
  onOpenChange,
  menus,
  feedbackUrl,
  pathname,
  profile,
  oidcAvailable,
  passwordLoginEnabled,
  theme,
  onToggleTheme,
  onChangePassword,
  onOidcBind,
  onOidcSync,
  onOidcUnbind,
  onLogout,
}: MobileNavSheetProps) {
  const close = () => onOpenChange(false);
  const themeLabel = theme === "dark" ? "切换到浅色模式" : "切换到深色模式";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[320px] p-0">
        <SheetHeader className="border-b border-[var(--color-border)] px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="min-w-0">
              <SheetTitle>后台导航</SheetTitle>
              <SheetDescription>快速切换页面与管理账号。</SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1 px-4 py-4">
            <div className="space-y-1">
              {menus.map((item) => {
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={close}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors duration-150",
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
              {feedbackUrl ? (
                <a
                  href={feedbackUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={close}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-sm text-[var(--color-foreground-muted)] transition-colors duration-150 hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)]"
                >
                  <MessageSquare className="h-4 w-4 shrink-0" />
                  <span>问题反馈</span>
                </a>
              ) : null}
            </div>
          </ScrollArea>
          <Separator />
          <div className="space-y-3 p-4">
            <Button variant="outline" className="w-full" onClick={onToggleTheme}>
              {theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              {themeLabel}
            </Button>
            {profile ? <MobileProfileSummary profile={profile} /> : null}
            {passwordLoginEnabled ? (
              <Button
                variant="outline"
                className="w-full justify-between"
                onClick={() => {
                  close();
                  onChangePassword();
                }}
              >
                修改密码
              </Button>
            ) : null}
            {oidcAvailable ? (
              profile?.oidc_subject ? (
                <>
                  <Button variant="outline" className="w-full justify-between" onClick={() => { close(); onOidcSync(); }}>
                    同步 OIDC
                    <span className="text-[10px] text-[var(--color-accent)]">已绑定</span>
                  </Button>
                  <Button variant="outline" className="w-full" onClick={() => { close(); onOidcUnbind(); }}>
                    解绑 OIDC
                  </Button>
                </>
              ) : (
                <Button variant="outline" className="w-full justify-between" onClick={() => { close(); onOidcBind(); }}>
                  绑定 OIDC
                  <span className="text-[10px] text-[var(--color-foreground-subtle)]">未绑定</span>
                </Button>
              )
            ) : null}
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => {
                close();
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
  );
}

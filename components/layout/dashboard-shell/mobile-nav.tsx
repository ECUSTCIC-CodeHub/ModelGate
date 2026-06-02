"use client";

import Link from "next/link";
import { LogOut, Moon, Shield, ShieldCheck, Sun } from "lucide-react";
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
  pathname: string;
  profile: ProfileBrief | null;
  oidcAvailable: boolean;
  theme: string;
  onToggleTheme: () => void;
  onChangePassword: () => void;
  onOidcBind: () => void;
  onOidcSync: () => void;
  onOidcUnbind: () => void;
  onTotpManage: () => void;
  onLogout: () => void;
};

export function MobileNavSheet({
  open,
  onOpenChange,
  menus,
  pathname,
  profile,
  oidcAvailable,
  theme,
  onToggleTheme,
  onChangePassword,
  onOidcBind,
  onOidcSync,
  onOidcUnbind,
  onTotpManage,
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
        <div className="flex h-full flex-col">
          <ScrollArea className="flex-1 px-4 py-4">
            <div className="space-y-1">
              {menus.map((item) => {
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={close}
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
            </div>
          </ScrollArea>
          <Separator />
          <div className="space-y-3 p-4">
            <Button variant="outline" className="w-full" onClick={onToggleTheme}>
              {theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              {themeLabel}
            </Button>
            {profile ? <MobileProfileSummary profile={profile} /> : null}
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
            <Button
              variant="outline"
              className="w-full justify-between"
              onClick={() => {
                close();
                onTotpManage();
              }}
            >
              {profile?.totp_enabled === 1 ? <ShieldCheck className="h-4 w-4" /> : <Shield className="h-4 w-4" />}
              双因素认证
              <span className={`text-[10px] ${profile?.totp_enabled === 1 ? "text-[var(--color-accent)]" : "text-[var(--color-foreground-subtle)]"}`}>
                {profile?.totp_enabled === 1 ? "已启用" : "未启用"}
              </span>
            </Button>
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

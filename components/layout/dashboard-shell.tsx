"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuthProfile, useLogoUrl, useOidcEnabled } from "@/components/providers/auth-provider";
import { useTheme } from "@/components/providers/theme-provider";
import { useToast } from "@/components/ui/toast";
import { DashboardSidebar } from "@/components/layout/dashboard-shell/sidebar";
import { DashboardTopbar } from "@/components/layout/dashboard-shell/topbar";
import { getDashboardMenus } from "@/components/layout/dashboard-shell/menus";
import { MobileNavSheet } from "@/components/layout/dashboard-shell/mobile-nav";
import { PasswordDialog } from "@/components/layout/dashboard-shell/password-dialog";
import type { DashboardShellProps, ProfileBrief } from "@/components/layout/dashboard-shell/types";
import { authedFetch, clearCachedProfile, clearSession, getCachedProfile, getOrFetchProfile } from "@/lib/auth/client-auth";
import { getApiMessage } from "@/lib/shared/api-message";

export function DashboardShell({ role, title, subtitle, right, children }: DashboardShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const initialProfile = useAuthProfile();
  const menus = getDashboardMenus(role);
  const { toast } = useToast();
  const { theme, toggle: toggleTheme } = useTheme();
  const [profileBrief, setProfileBrief] = useState<ProfileBrief | null>(() => initialProfile ?? getCachedProfile());
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const oidcAvailable = useOidcEnabled();
  const logoUrl = useLogoUrl();

  useEffect(() => {
    clearCachedProfile();
    void getOrFetchProfile().then((next) => {
      if (next) setProfileBrief(next);
    });
  }, []);

  function openPasswordDialog() {
    setPasswordDialogOpen(true);
  }

  function onLogout() {
    void fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).finally(() => {
      clearSession();
      router.replace("/login");
    });
  }

  function onOidcBind() {
    window.location.href = "/api/auth/oidc/bind";
  }

  function onOidcSync() {
    window.location.href = "/api/auth/oidc/bind";
  }

  async function refreshProfile() {
    clearCachedProfile();
    const next = await getOrFetchProfile();
    if (next) setProfileBrief(next);
  }

  async function onOidcUnbind() {
    const response = await authedFetch("/api/auth/oidc/unbind", { method: "POST" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "OIDC 绑定已解除。") });
      void refreshProfile();
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
    setPasswordDialogOpen(false);
  }

  return (
    <main className="min-h-screen text-[var(--color-foreground)]">
      <div className="flex min-h-screen gap-3 px-3 py-3 lg:gap-5 lg:px-5">
        <DashboardSidebar
          menus={menus}
          pathname={pathname}
          logoUrl={logoUrl}
          profile={profileBrief}
          oidcAvailable={oidcAvailable}
          onChangePassword={openPasswordDialog}
          onOidcBind={onOidcBind}
          onOidcSync={onOidcSync}
          onOidcUnbind={onOidcUnbind}
          onLogout={onLogout}
        />

        <section className="flex min-w-0 flex-1 flex-col gap-4">
          <DashboardTopbar
            title={title}
            subtitle={subtitle}
            right={right}
            theme={theme}
            onToggleTheme={toggleTheme}
            onOpenMobileNav={() => setMobileNavOpen(true)}
          />
          <div className="min-h-0 flex-1">{children}</div>
        </section>
      </div>

      <MobileNavSheet
        open={mobileNavOpen}
        onOpenChange={setMobileNavOpen}
        menus={menus}
        pathname={pathname}
        logoUrl={logoUrl}
        profile={profileBrief}
        theme={theme}
        oidcAvailable={oidcAvailable}
        onToggleTheme={toggleTheme}
        onChangePassword={openPasswordDialog}
        onOidcBind={onOidcBind}
        onOidcSync={onOidcSync}
        onOidcUnbind={onOidcUnbind}
        onLogout={onLogout}
      />

      <PasswordDialog
        open={passwordDialogOpen}
        onOpenChange={setPasswordDialogOpen}
        currentPassword={currentPassword}
        newPassword={newPassword}
        onCurrentPasswordChange={setCurrentPassword}
        onNewPasswordChange={setNewPassword}
        onSubmit={onChangePassword}
      />
    </main>
  );
}

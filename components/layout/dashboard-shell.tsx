"use client";

import { DashboardSidebar } from "@/components/layout/dashboard-shell/sidebar";
import { DashboardTopbar } from "@/components/layout/dashboard-shell/topbar";
import { MobileNavSheet } from "@/components/layout/dashboard-shell/mobile-nav";
import { PasswordDialog } from "@/components/layout/dashboard-shell/password-dialog";
import type { DashboardShellProps } from "@/components/layout/dashboard-shell/types";
import { useDashboardShell } from "@/components/layout/dashboard-shell/use-dashboard-shell";

export function DashboardShell({ role, title, subtitle, right, children }: DashboardShellProps) {
  const shell = useDashboardShell(role);

  return (
    <main className="min-h-screen text-[var(--color-foreground)]">
      <div className="flex min-h-screen gap-3 px-3 py-3 lg:gap-5 lg:px-5">
        <DashboardSidebar
          menus={shell.menus}
          pathname={shell.pathname}
          logoUrl={shell.logoUrl}
          profile={shell.profileBrief}
          oidcAvailable={shell.oidcAvailable}
          onChangePassword={shell.openPasswordDialog}
          onOidcBind={shell.onOidcBind}
          onOidcSync={shell.onOidcSync}
          onOidcUnbind={shell.onOidcUnbind}
          onLogout={shell.onLogout}
        />

        <section className="flex min-w-0 flex-1 flex-col gap-4">
          <DashboardTopbar
            title={title}
            subtitle={subtitle}
            right={right}
            theme={shell.theme}
            onToggleTheme={shell.toggleTheme}
            onOpenMobileNav={() => shell.setMobileNavOpen(true)}
          />
          <div className="min-h-0 flex-1">{children}</div>
        </section>
      </div>

      <MobileNavSheet
        open={shell.mobileNavOpen}
        onOpenChange={shell.setMobileNavOpen}
        menus={shell.menus}
        pathname={shell.pathname}
        logoUrl={shell.logoUrl}
        profile={shell.profileBrief}
        theme={shell.theme}
        oidcAvailable={shell.oidcAvailable}
        onToggleTheme={shell.toggleTheme}
        onChangePassword={shell.openPasswordDialog}
        onOidcBind={shell.onOidcBind}
        onOidcSync={shell.onOidcSync}
        onOidcUnbind={shell.onOidcUnbind}
        onLogout={shell.onLogout}
      />

      <PasswordDialog
        open={shell.passwordDialogOpen}
        onOpenChange={shell.setPasswordDialogOpen}
        currentPassword={shell.currentPassword}
        newPassword={shell.newPassword}
        onCurrentPasswordChange={shell.setCurrentPassword}
        onNewPasswordChange={shell.setNewPassword}
        onSubmit={shell.onChangePassword}
      />
    </main>
  );
}

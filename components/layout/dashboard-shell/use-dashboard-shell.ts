"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useAuthProfile, useOidcEnabled, usePasswordLoginEnabled } from "@/components/providers/auth-provider";
import { useTheme } from "@/components/providers/theme-provider";
import { useToast } from "@/components/ui/toast";
import { getDashboardMenus } from "@/components/layout/dashboard-shell/menus";
import type { ProfileBrief, Role } from "@/components/layout/dashboard-shell/types";
import { authedFetch, clearCachedProfile, clearSession, getCachedProfile, getOrFetchProfile } from "@/lib/auth/client-auth";
import { getApiMessage } from "@/lib/shared/api-message";

export function useDashboardShell(role: Role) {
  const pathname = usePathname();
  const router = useRouter();
  const initialProfile = useAuthProfile();
  const { toast } = useToast();
  const { theme, toggle: toggleTheme } = useTheme();
  const menus = useMemo(() => getDashboardMenus(role), [role]);
  const [profileBrief, setProfileBrief] = useState<ProfileBrief | null>(() => initialProfile ?? getCachedProfile());
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [feedbackUrl, setFeedbackUrl] = useState("");
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [totpDialogOpen, setTotpDialogOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const oidcAvailable = useOidcEnabled();
  const passwordLoginEnabled = usePasswordLoginEnabled();

  useEffect(() => {
    clearCachedProfile();
    void getOrFetchProfile().then((next) => {
      if (next) setProfileBrief(next);
    });
  }, []);

  useEffect(() => {
    void fetch("/api/site-info", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        const url = data?.data?.feedback_url;
        if (typeof url === "string" && url.trim()) setFeedbackUrl(url.trim());
      })
      .catch(() => {});
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

  return {
    currentPassword,
    feedbackUrl,
    menus,
    mobileNavOpen,
    newPassword,
    oidcAvailable,
    passwordLoginEnabled,
    passwordDialogOpen,
    pathname,
    profileBrief,
    setCurrentPassword,
    setMobileNavOpen,
    setNewPassword,
    setPasswordDialogOpen,
    theme,
    toggleTheme,
    totpDialogOpen,
    setTotpDialogOpen,
    onChangePassword,
    onLogout,
    onOidcBind,
    onOidcSync,
    onOidcUnbind,
    openPasswordDialog,
    refreshProfile,
  };
}

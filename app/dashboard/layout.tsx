import { AnnouncementDialog } from "@/components/dashboard/announcement-dialog";
import { AuthProvider } from "@/components/providers/auth-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { getServerProfileFromCookieStore } from "@/lib/auth/auth";
import { getAuthStatus } from "@/lib/auth/auth-status";
import { type DbUser } from "@/lib/core/db";
import { getEffectiveLimits } from "@/lib/gateway/effective-limits";
import { modelGateFeatures } from "@/lib/core/features";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const PREFS_COOKIE = "modelgate-prefs";

function parsePrefs(cookieValue: string | undefined): { appearance: "default" | "retro"; mode: "light" | "dark" | "system" } | null {
  if (!cookieValue) return null;
  const parts = cookieValue.split(",");
  if (parts.length !== 2) return null;
  const [appearance, mode] = parts;
  if (appearance !== "default" && appearance !== "retro") return null;
  if (mode !== "light" && mode !== "dark" && mode !== "system") return null;
  return { appearance, mode };
}

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const profile = await getServerProfileFromCookieStore(cookieStore);

  if (!profile) {
    // 未登录直接跳登录页；不要走 /api/auth/logout，
    // 避免该 route 在反代/standalone 场景下基于 request.url 生成内部地址的绝对跳转。
    redirect("/login");
  }

  const prefsCookie = cookieStore.get(PREFS_COOKIE)?.value;
  const prefs = parsePrefs(prefsCookie);

  const effective = await getEffectiveLimits(profile as DbUser);
  const enrichedProfile = {
    ...profile,
    rpm: effective.rpm,
    qps: effective.qps,
    tpm: effective.tpm,
    quota_tokens: effective.quota_tokens,
    quota_requests: effective.quota_requests,
    quota_period: effective.quota_period,
    period_quota_tokens: effective.period_quota_tokens,
    period_quota_requests: effective.period_quota_requests,
  };

  const authStatus = await getAuthStatus();

  return (
    <ThemeProvider
      initialAppearance={prefs?.appearance}
      initialMode={prefs?.mode}
    >
      <AuthProvider
        initialProfile={enrichedProfile}
        oidcEnabled={authStatus.oidc_enabled}
        passwordLoginEnabled={authStatus.password_login_enabled}
      >
        {children}
        {modelGateFeatures.announcement ? <AnnouncementDialog /> : null}
      </AuthProvider>
    </ThemeProvider>
  );
}

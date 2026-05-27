import { AnnouncementDialog } from "@/components/dashboard/announcement-dialog";
import { AuthProvider } from "@/components/providers/auth-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { getServerProfileFromCookieStore } from "@/lib/auth";
import { getAuthStatus } from "@/lib/auth-status";
import { type DbUser } from "@/lib/db";
import { getEffectiveLimits } from "@/lib/effective-limits";
import { modelGateFeatures } from "@/lib/features";
import { getGatewaySettings } from "@/lib/settings";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const profile = getServerProfileFromCookieStore(cookieStore);

  if (!profile) {
    // 未登录直接跳登录页；不要走 /api/auth/logout，
    // 避免该 route 在反代/standalone 场景下基于 request.url 生成内部地址的绝对跳转。
    redirect("/login");
  }

  const effective = getEffectiveLimits(profile as DbUser);
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

  const authStatus = getAuthStatus();
  const { logo_url } = getGatewaySettings();

  return (
    <ThemeProvider>
      <AuthProvider initialProfile={enrichedProfile} oidcEnabled={authStatus.oidc_enabled} logoUrl={logo_url}>
        {children}
        {modelGateFeatures.announcement ? <AnnouncementDialog /> : null}
      </AuthProvider>
    </ThemeProvider>
  );
}

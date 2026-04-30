import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthProvider } from "@/components/providers/auth-provider";
import { getServerProfileFromCookieStore } from "@/lib/auth";
import { getAuthStatus } from "@/lib/auth-status";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const profile = getServerProfileFromCookieStore(cookieStore);

  if (!profile) {
    redirect("/login");
  }

  const authStatus = getAuthStatus();

  return (
    <AuthProvider initialProfile={profile} oidcEnabled={authStatus.oidc_enabled}>
      {children}
    </AuthProvider>
  );
}

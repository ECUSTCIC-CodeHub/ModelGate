import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthProvider } from "@/components/providers/auth-provider";
import { getServerProfileFromCookieStore } from "@/lib/auth";

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

  return <AuthProvider initialProfile={profile}>{children}</AuthProvider>;
}

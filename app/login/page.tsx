export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthStatus } from "@/lib/auth/auth-status";
import { getServerProfileFromCookieStore } from "@/lib/auth/auth";
import { AUTH_DISABLED } from "@/lib/auth/no-auth";
import { resolveSafeNext } from "@/lib/shared/safe-next";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; oidc_error?: string }>;
}) {
  if (AUTH_DISABLED) {
    redirect("/dashboard");
  }

  const { next, oidc_error } = await searchParams;
  const profile = await getServerProfileFromCookieStore(await cookies());
  if (profile && !oidc_error) {
    redirect(resolveSafeNext(next));
  }

  const status = await getAuthStatus();
  return <LoginForm status={status} />;
}

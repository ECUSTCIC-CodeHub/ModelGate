export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { OIDC_PENDING_COOKIE_NAME } from "@/lib/auth/auth";
import { getAuthStatus } from "@/lib/auth/auth-status";
import { getOidcConfig } from "@/lib/auth/oidc";
import { modelGateFeatures } from "@/lib/core/features";
import { gatewayDb } from "@/lib/core/db";
import { AUTH_DISABLED } from "@/lib/auth/no-auth";
import { BindForm } from "./bind-form";

export default async function OidcBindPage() {
  if (!modelGateFeatures.oidc) notFound();
  if (AUTH_DISABLED) redirect("/dashboard");

  const status = getAuthStatus();
  if (!status.oidc_enabled) redirect("/login");

  const cookieStore = await cookies();
  const pending = cookieStore.get(OIDC_PENDING_COOKIE_NAME);
  if (!pending) redirect("/login");

  const config = getOidcConfig();
  const allowCreate = config.autoRegister || (() => {
    const adminCount = gatewayDb
      .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND deleted_at IS NULL")
      .get() as { count: number };
    return adminCount.count === 0;
  })();

  return <BindForm allowCreate={allowCreate} />;
}

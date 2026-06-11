export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getAuthStatus } from "@/lib/auth/auth-status";
import { AUTH_DISABLED } from "@/lib/auth/no-auth";
import { RegisterForm } from "./register-form";

export default async function RegisterPage() {
  if (AUTH_DISABLED) {
    redirect("/dashboard");
  }

  const status = await getAuthStatus();

  if (!status.registration_enabled && !status.oidc_enabled) {
    redirect("/login");
  }

  return <RegisterForm status={status} />;
}

export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getAuthStatus } from "@/lib/auth/auth-status";
import { AUTH_DISABLED } from "@/lib/auth/no-auth";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  if (AUTH_DISABLED) {
    redirect("/dashboard");
  }

  const status = await getAuthStatus();
  return <LoginForm status={status} />;
}

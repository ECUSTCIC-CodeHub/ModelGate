export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getAuthStatus } from "@/lib/auth/auth-status";
import { AUTH_DISABLED } from "@/lib/auth/no-auth";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  if (AUTH_DISABLED) {
    redirect("/dashboard");
  }

  const status = getAuthStatus();
  return <LoginForm status={status} />;
}

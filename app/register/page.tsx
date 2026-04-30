export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getAuthStatus } from "@/lib/auth-status";
import { RegisterForm } from "./register-form";

export default function RegisterPage() {
  const status = getAuthStatus();

  if (!status.registration_enabled && !status.oidc_enabled) {
    redirect("/login");
  }

  return <RegisterForm status={status} />;
}

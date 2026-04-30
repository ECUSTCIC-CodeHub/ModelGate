export const dynamic = "force-dynamic";

import { getAuthStatus } from "@/lib/auth-status";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  const status = getAuthStatus();
  return <LoginForm status={status} />;
}

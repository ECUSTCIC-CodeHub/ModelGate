export const dynamic = "force-dynamic";

import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";

export async function GET(request: Request) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;
  return jsonOk({ user: guard.auth.user });
}

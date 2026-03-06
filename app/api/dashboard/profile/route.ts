import { ensureWebUser } from "@/lib/guards";
import { jsonOk } from "@/lib/http";

export async function GET(request: Request) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;
  return jsonOk({ user: guard.auth.user });
}

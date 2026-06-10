export const dynamic = "force-dynamic";

import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";

export async function GET(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const user = guard.auth.user;
  const row = await gatewayDb
    .queryOne<{ totp_enabled: number }>("SELECT totp_enabled FROM users WHERE id = ? AND deleted_at IS NULL", [user.id]);

  return jsonOk({
    totp_enabled: row?.totp_enabled === 1,
  });
}

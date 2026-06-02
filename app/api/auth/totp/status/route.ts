export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk, jsonError } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";

export async function GET(request: Request) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const user = guard.auth.user;
  const row = gatewayDb
    .prepare("SELECT totp_enabled FROM users WHERE id = ? AND deleted_at IS NULL")
    .get(user.id) as { totp_enabled: number } | undefined;

  return jsonOk({
    totp_enabled: row?.totp_enabled === 1,
  });
}

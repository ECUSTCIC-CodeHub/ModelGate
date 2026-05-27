export const dynamic = "force-dynamic";

import { ensureWebUser } from "@/lib/auth/guards";
import { requireFeature } from "@/lib/core/features";
import { jsonOk } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";

export async function GET(request: Request) {
  const unavailable = requireFeature("announcement");
  if (unavailable) return unavailable;

  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const row = gatewayDb
    .prepare("SELECT value FROM settings WHERE key = 'announcement_content'")
    .get() as { value: string } | undefined;

  return jsonOk({ content: row?.value ?? "" });
}

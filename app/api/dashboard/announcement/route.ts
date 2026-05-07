export const dynamic = "force-dynamic";

import { ensureWebUser } from "@/lib/guards";
import { jsonOk } from "@/lib/http";
import { gatewayDb } from "@/lib/db";

export async function GET(request: Request) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const row = gatewayDb
    .prepare("SELECT value FROM settings WHERE key = 'announcement_content'")
    .get() as { value: string } | undefined;

  return jsonOk({ content: row?.value ?? "" });
}

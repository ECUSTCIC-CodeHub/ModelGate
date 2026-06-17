export const dynamic = "force-dynamic";

import { ensureWebUser } from "@/lib/auth/guards";
import { requireFeature } from "@/lib/core/features";
import { jsonOk } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";

export async function GET(request: Request) {
  const unavailable = requireFeature("announcement");
  if (unavailable) return unavailable;

  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const row = await gatewayDb
    .queryOne<{ id: number; title: string; content: string; pinned: number; created_at: string }>(
      "SELECT id, title, content, pinned, created_at FROM announcements ORDER BY created_at DESC LIMIT 1",
    );

  if (!row) return jsonOk({ content: "", id: null, title: "" });

  return jsonOk({ content: row.content, id: row.id, title: row.title });
}

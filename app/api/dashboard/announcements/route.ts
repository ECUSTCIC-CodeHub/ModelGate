export const dynamic = "force-dynamic";

import { ensureWebUser } from "@/lib/auth/guards";
import { requireFeature } from "@/lib/core/features";
import { jsonOk } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";
import { getGatewaySettings } from "@/lib/core/settings";

export async function GET(request: Request) {
  const unavailable = requireFeature("announcement");
  if (unavailable) return unavailable;

  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const settings = await getGatewaySettings();
  const limit = Math.min(20, Math.max(1, settings.announcement_display_count));

  const rows = await gatewayDb.query<{
    id: number;
    title: string;
    content: string;
    pinned: number;
    created_at: string;
  }>(
    "SELECT id, title, content, pinned, created_at FROM announcements ORDER BY pinned DESC, created_at DESC LIMIT ?",
    [limit],
  );

  return jsonOk({
    message: "公告列表获取成功。",
    data: rows,
  });
}

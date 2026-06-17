export const dynamic = "force-dynamic";

import { z } from "zod";
import { requireFeature } from "@/lib/core/features";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";

const createSchema = z.object({
  title: z.string().min(1).max(255),
  content: z.string().min(1).max(10000),
  pinned: z.boolean().optional(),
});

export async function GET(request: Request) {
  const unavailable = requireFeature("announcement");
  if (unavailable) return unavailable;

  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const rows = await gatewayDb.query<{
    id: number;
    title: string;
    content: string;
    pinned: number;
    created_at: string;
  }>("SELECT id, title, content, pinned, created_at FROM announcements ORDER BY pinned DESC, created_at DESC");

  return jsonOk({ message: "公告列表获取成功。", data: rows });
}

export async function POST(request: Request) {
  const unavailable = requireFeature("announcement");
  if (unavailable) return unavailable;

  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const { title, content, pinned } = parsed.data;
  const result = await gatewayDb.execute(
    "INSERT INTO announcements (title, content, pinned) VALUES (?, ?, ?)",
    [title, content, pinned ? 1 : 0],
  );

  const row = await gatewayDb.queryOne<{
    id: number;
    title: string;
    content: string;
    pinned: number;
    created_at: string;
  }>("SELECT id, title, content, pinned, created_at FROM announcements WHERE id = ?", [result.lastInsertRowid]);

  return jsonOk({ message: "公告创建成功。", data: row }, 201);
}

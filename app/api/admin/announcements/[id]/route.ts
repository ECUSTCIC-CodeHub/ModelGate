export const dynamic = "force-dynamic";

import { z } from "zod";
import { requireFeature } from "@/lib/core/features";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";

const updateSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  content: z.string().min(1).max(10000).optional(),
  pinned: z.boolean().optional(),
});

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const unavailable = requireFeature("announcement");
  if (unavailable) return unavailable;

  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id: idStr } = await context.params;
  const id = Number(idStr);
  if (!Number.isFinite(id) || id <= 0) return jsonError("公告 ID 不正确", 400);

  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const existing = await gatewayDb.queryOne<{ id: number }>(
    "SELECT id FROM announcements WHERE id = ?",
    [id],
  );
  if (!existing) return jsonError("公告不存在", 404);

  const sets: string[] = [];
  const params: unknown[] = [];
  if (parsed.data.title !== undefined) {
    sets.push("title = ?");
    params.push(parsed.data.title);
  }
  if (parsed.data.content !== undefined) {
    sets.push("content = ?");
    params.push(parsed.data.content);
  }
  if (parsed.data.pinned !== undefined) {
    sets.push("pinned = ?");
    params.push(parsed.data.pinned ? 1 : 0);
  }
  if (sets.length > 0) {
    params.push(id);
    await gatewayDb.execute(`UPDATE announcements SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  const row = await gatewayDb.queryOne<{
    id: number;
    title: string;
    content: string;
    pinned: number;
    created_at: string;
  }>("SELECT id, title, content, pinned, created_at FROM announcements WHERE id = ?", [id]);

  return jsonOk({ message: "公告更新成功。", data: row });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const unavailable = requireFeature("announcement");
  if (unavailable) return unavailable;

  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id: idStr } = await context.params;
  const id = Number(idStr);
  if (!Number.isFinite(id) || id <= 0) return jsonError("公告 ID 不正确", 400);

  const result = await gatewayDb.execute("DELETE FROM announcements WHERE id = ?", [id]);
  if (result.changes === 0) return jsonError("公告不存在", 404);

  return jsonOk({ message: "公告删除成功。" });
}

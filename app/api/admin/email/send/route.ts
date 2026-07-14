export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureAdminWeb } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";
import { notifyBroadcastAsync, isBroadcastSending } from "@/lib/core/email";

const schema = z
  .object({
    title: z.string().min(1).max(500),
    content: z.string().min(1).max(20000),
    target: z.enum(["all", "group"]),
    group_id: z.number().int().positive().nullable().optional(),
  })
  .refine((v) => v.target !== "group" || typeof v.group_id === "number", {
    message: "选择用户组时必须提供 group_id",
    path: ["group_id"],
  });

export async function POST(request: Request) {
  const guard = await ensureAdminWeb(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const { title, content, target, group_id } = parsed.data;

  if (target === "group") {
    const group = await gatewayDb.queryOne<{ id: number }>(
      "SELECT id FROM `groups` WHERE id = ? AND deleted_at IS NULL",
      [group_id!],
    );
    if (!group) return jsonError("指定的用户组不存在", 404);
  }

  if (isBroadcastSending()) {
    return jsonError("已有广播邮件发送任务进行中，请稍后再试。", 409);
  }

  notifyBroadcastAsync({
    title,
    content,
    groupId: target === "group" ? group_id : null,
  });

  return jsonOk({
    message: "广播邮件已提交，将在后台发送，请勿重复提交。",
  });
}

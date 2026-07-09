export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { deleteSender, updateSender, type EmailSenderInput } from "@/lib/core/email";

const senderSchema = z.object({
  name: z.string().min(1).max(100),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  auth_user: z.string().max(255).optional().default(""),
  auth_pass: z.string().max(500).optional().default(""),
  from_address: z.string().min(1).max(255),
  from_name: z.string().max(100).optional().default(""),
  daily_limit: z.number().int().min(0).max(100000).optional().default(0),
  priority: z.number().int().min(-100000).max(100000).optional().default(0),
  enabled: z.boolean().optional().default(true),
});

function mapSender(sender: NonNullable<Awaited<ReturnType<typeof updateSender>>>) {
  return {
    id: sender.id,
    name: sender.name,
    host: sender.host,
    port: sender.port,
    secure: sender.secure,
    auth_user: sender.authUser,
    auth_pass: sender.authPass ? "••••••••" : "",
    from_address: sender.fromAddress,
    from_name: sender.fromName,
    daily_limit: sender.dailyLimit,
    priority: sender.priority,
    enabled: sender.enabled,
    sent_today: sender.sentToday,
    sent_date: sender.sentDate,
  };
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id: idStr } = await context.params;
  const id = Number(idStr);
  if (!Number.isFinite(id) || id <= 0) return jsonError("发件账号 ID 不正确", 400);

  const body = await request.json().catch(() => null);
  const parsed = senderSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const input: EmailSenderInput = {
    name: parsed.data.name,
    host: parsed.data.host,
    port: parsed.data.port,
    secure: parsed.data.secure,
    authUser: parsed.data.auth_user,
    authPass: parsed.data.auth_pass,
    fromAddress: parsed.data.from_address,
    fromName: parsed.data.from_name,
    dailyLimit: parsed.data.daily_limit,
    priority: parsed.data.priority,
    enabled: parsed.data.enabled,
  };

  const sender = await updateSender(id, input);
  if (!sender) return jsonError("发件账号不存在", 404);

  return jsonOk({ message: "发件账号已更新。", data: mapSender(sender) });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id: idStr } = await context.params;
  const id = Number(idStr);
  if (!Number.isFinite(id) || id <= 0) return jsonError("发件账号 ID 不正确", 400);

  const ok = await deleteSender(id);
  if (!ok) return jsonError("发件账号不存在", 404);

  return jsonOk({ message: "发件账号已删除。" });
}

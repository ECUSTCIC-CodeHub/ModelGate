export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { getEmailSettings, getSender } from "@/lib/core/email";
import { sendSmtpMessages, type SmtpMessage } from "@/lib/core/email/smtp";

const schema = z.object({
  to: z.string().max(255).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id: idStr } = await context.params;
  const id = Number(idStr);
  if (!Number.isFinite(id) || id <= 0) return jsonError("发件账号 ID 不正确", 400);

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const sender = await getSender(id);
  if (!sender) return jsonError("发件账号不存在", 404);

  const settings = await getEmailSettings();
  const to = parsed.data.to?.trim() || sender.fromAddress;
  if (!to) return jsonError("请提供测试收件邮箱或配置发件地址。", 400);

  const fromName = sender.fromName || settings.fromName || undefined;
  const message: SmtpMessage = {
    from: { address: sender.fromAddress, name: fromName },
    to,
    subject: "【测试】ModelGate 邮件配置",
    text: "这是一封来自 ModelGate 的测试邮件，说明邮件服务配置正确。",
    html: "<p>这是一封来自 <strong>ModelGate</strong> 的测试邮件，说明邮件服务配置正确。</p>",
  };

  const server = {
    host: sender.host,
    port: sender.port,
    secure: sender.secure,
    auth: sender.authUser ? { user: sender.authUser, pass: sender.authPass } : undefined,
  };

  const result = await sendSmtpMessages(server, [message]);
  if (result.failed > 0) {
    return jsonError(`测试邮件发送失败：${result.errors.join("；")}`, 502);
  }

  return jsonOk({ message: `测试邮件已发送至 ${to}。` });
}

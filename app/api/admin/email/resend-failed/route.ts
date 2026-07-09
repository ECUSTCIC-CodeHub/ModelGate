export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { resendFailedEmails } from "@/lib/core/email";

const schema = z.object({
  announcement_id: z.number().int().positive().optional(),
});

export async function POST(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const summary = await resendFailedEmails(parsed.data.announcement_id);
  if (summary.attempted === 0) {
    return jsonOk({ message: "没有需要重发的失败邮件。", data: summary });
  }
  return jsonOk({
    message: `已处理失败邮件重发：尝试 ${summary.attempted} 封，成功 ${summary.sent}，失败 ${summary.failed}。`,
    data: summary,
  });
}

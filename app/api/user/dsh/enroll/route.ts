export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureUser } from "@/lib/auth/guards";
import { jsonError, jsonOk, dbCapacityResponse } from "@/lib/core/http";
import { readJsonBodyCapped } from "@/lib/core/request-body";
import { enrollDsh } from "@/lib/services/dsh-enroll";

const enrollSchema = z.object({
  callback_url: z.string().url().max(512).optional().nullable(),
  client_id: z.string().max(128).optional().nullable(),
});

const FAILURE_MESSAGES = {
  key_limit: "密钥数量已达上限，请先删除不用的密钥",
  enroll_limit: "待兑换的授权码过多，请稍后再试",
  code_conflict: "授权码生成失败，请重试",
} as const;

export async function POST(request: Request) {
  const guard = await ensureUser(request);
  if ("error" in guard) return guard.error;

  const body = await readJsonBodyCapped(request);
  if (!body.ok) return jsonError("请求体过大", 413);
  const parsed = enrollSchema.safeParse(body.data ?? {});
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const { callback_url, client_id } = parsed.data;

  try {
    const result = await enrollDsh(guard.auth.user.id, {
      callbackUrl: callback_url ?? null,
      clientId: client_id ?? null,
    });
    if (!result.ok) return jsonError(FAILURE_MESSAGES[result.reason], 400);

    // 不回传明文密钥给网页：明文只通过本机回调或兑换码到达 DSH
    return jsonOk({
      message: "兑换码已生成，请在 DSH 里粘贴兑换码完成接入。",
      data: {
        code: result.enrollment.code,
        expires_at: result.enrollment.expiresAt,
        key_masked: result.enrollment.maskedKey,
      },
    }, 201);
  } catch (err) {
    const busy = dbCapacityResponse(err);
    if (busy) return busy;
    console.error("[dsh] 颁发兑换码失败", err);
    return jsonError("颁发兑换码失败，请稍后重试", 500);
  }
}

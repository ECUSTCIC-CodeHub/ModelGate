export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureUser } from "@/lib/auth/guards";
import { jsonError, jsonOk, dbCapacityResponse } from "@/lib/core/http";
import { readJsonBodyCapped } from "@/lib/core/request-body";
import { enrollDsh, deliverToDsh } from "@/lib/services/dsh-enroll";

const enrollSchema = z.object({
  callback_url: z.string().url().max(512).optional().nullable(),
  client_id: z.string().max(128).optional().nullable(),
  reuse: z.boolean().optional(),
});

export async function POST(request: Request) {
  const guard = await ensureUser(request);
  if ("error" in guard) return guard.error;

  const body = await readJsonBodyCapped(request);
  if (!body.ok) return jsonError("请求体过大", 413);
  const parsed = enrollSchema.safeParse(body.data);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const { callback_url, client_id, reuse } = parsed.data;

  try {
    const enrollment = await enrollDsh(guard.auth.user.id, {
      reuse: reuse ?? true,
      callbackUrl: callback_url ?? null,
      clientId: client_id ?? null,
    });

    let delivered = false;
    if (callback_url) {
      delivered = await deliverToDsh(enrollment.id, callback_url, {
        code: enrollment.code,
        key: enrollment.key,
        clientId: client_id ?? null,
      });
    }

    // 不回传明文密钥给网页——网页只需要知道投递是否成功，明文密钥只通过回调或兑换码到达 DSH
    return jsonOk({
      message: delivered ? "密钥已投递到本机 DSH。" : "兑换码已生成，请在 DSH 里粘贴兑换码完成接入。",
      data: {
        code: enrollment.code,
        expires_at: enrollment.expiresAt,
        key_masked: enrollment.maskedKey,
        delivered,
      },
    }, 201);
  } catch (err) {
    const busy = dbCapacityResponse(err);
    if (busy) return busy;
    throw err;
  }
}

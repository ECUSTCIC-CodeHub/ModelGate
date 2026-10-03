export const dynamic = "force-dynamic";

import { z } from "zod";
import { requireRedeemCodeFeature } from "@/lib/core/features";
import { getGatewaySettings } from "@/lib/core/settings";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { readJsonBodyCapped } from "@/lib/core/request-body";
import { gatewayDb } from "@/lib/core/db";
import { parseExpiresInput, getCodeById, getCodeDetail, listRedemptions, updateRedeemCode } from "@/lib/services/redeem-codes";

const patchSchema = z
  .strictObject({
    note: z.string().max(500).nullable().optional(),
    enabled: z.boolean().optional(),
    expires_at: z.string().nullable().optional(),
    max_uses: z.number().int().min(0).optional(),
    token_quota: z.number().int().min(1).nullable().optional(),
    request_quota: z.number().int().min(1).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "没有需要更新的字段" });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const unavailable = requireRedeemCodeFeature(await getGatewaySettings());
  if (unavailable) return unavailable;

  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await params;
  const codeId = Number(id);
  if (!Number.isFinite(codeId) || codeId <= 0) return jsonError("参数不正确", 400);

  const code = await getCodeById(codeId);
  if (!code) return jsonError("兑换码不存在", 404);

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

  const redemptions = await listRedemptions({ codeId, limit, offset });
  const detail = await getCodeDetail(codeId);
  return jsonOk({ data: detail ?? code, redemptions });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const unavailable = requireRedeemCodeFeature(await getGatewaySettings());
  if (unavailable) return unavailable;

  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await params;
  const codeId = Number(id);
  if (!Number.isFinite(codeId) || codeId <= 0) return jsonError("参数不正确", 400);

  const body = await readJsonBodyCapped(request);
  if (!body.ok) return jsonError("请求体过大", 413);
  const parsed = patchSchema.safeParse(body.data);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  // 额度与有效期属「只增不减」字段，落库前统一成无时区后缀的 UTC 裸字符串。
  // 有效期不允许清空：NULL 会被核销 SQL 的过期判定豁免，等于让额度永久有效。
  // 解析层面放行 null / 空串，把「不许清空」的定向文案交给 service 统一给出。
  let expiresAt: string | null | undefined;
  if (parsed.data.expires_at !== undefined) {
    const raw = parsed.data.expires_at?.trim() ?? null;
    if (raw === null || raw === "") {
      expiresAt = null;
    } else {
      const parsedExpiresAt = parseExpiresInput(raw);
      if (!parsedExpiresAt.ok) return jsonError(parsedExpiresAt.reason, 400);
      expiresAt = parsedExpiresAt.value;
    }
  }

  const result = await updateRedeemCode(codeId, {
    note: parsed.data.note,
    enabled: parsed.data.enabled,
    expiresAt,
    maxUses: parsed.data.max_uses,
    tokenQuota: parsed.data.token_quota,
    requestQuota: parsed.data.request_quota,
  });
  if (!result.ok) return jsonError(result.reason, 400);

  const detail = await getCodeDetail(codeId);
  return jsonOk({ message: "兑换码已更新。", data: detail });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const unavailable = requireRedeemCodeFeature(await getGatewaySettings());
  if (unavailable) return unavailable;

  const guard = await ensureAdmin(_request);
  if ("error" in guard) return guard.error;

  const { id } = await params;
  const codeId = Number(id);
  if (!Number.isFinite(codeId) || codeId <= 0) return jsonError("参数不正确", 400);

  const code = await getCodeById(codeId);
  if (!code) return jsonError("兑换码不存在", 404);

  await gatewayDb.transaction(async (tx) => {
    await tx.execute("DELETE FROM redeem_redemptions WHERE code_id = ?", [codeId]);
    await tx.execute("DELETE FROM redeem_balances WHERE code_id = ?", [codeId]);
    await tx.execute("DELETE FROM redeem_codes WHERE id = ?", [codeId]);
  });

  return jsonOk({ message: "兑换码已删除。" });
}

export const dynamic = "force-dynamic";

import { z } from "zod";
import { requireFeature } from "@/lib/core/features";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";
import { listExistingChannelIds } from "@/lib/gateway/channel-access";
import { listExistingModelAliases } from "@/lib/gateway/model-access";
import { toMysqlDatetime } from "@/lib/core/db/datetime";
import { generateRedeemCodes, listCodes, getCodeByCode } from "@/lib/services/redeem-codes";

const generateSchema = z.object({
  count: z.number().int().min(1).max(500),
  token_quota: z.number().int().min(1).nullable().optional(),
  request_quota: z.number().int().min(1).nullable().optional(),
  allowed_channel_ids: z.array(z.number().int().positive()).optional(),
  allowed_model_aliases: z.array(z.string().min(1)).optional(),
  expires_at: z.string().nullable().optional(),
  max_uses: z.number().int().min(0).default(1),
  note: z.string().max(500).optional(),
});

export async function GET(request: Request) {
  const unavailable = requireFeature("redeemCode");
  if (unavailable) return unavailable;

  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  const keyword = (url.searchParams.get("keyword") ?? "").trim();
  const batchId = (url.searchParams.get("batch_id") ?? "").trim() || undefined;

  const { data, total } = await listCodes({ keyword, limit, offset, batchId });
  return jsonOk({ data, paging: { limit, offset, total } });
}

export async function POST(request: Request) {
  const unavailable = requireFeature("redeemCode");
  if (unavailable) return unavailable;

  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  if (parsed.data.token_quota == null && parsed.data.request_quota == null) {
    return jsonError("Token 额度与请求额度至少填写一项", 400);
  }

  const channelIds = parsed.data.allowed_channel_ids ?? [];
  const existingChannels = await listExistingChannelIds(channelIds);
  const droppedChannels = channelIds.filter((id) => !existingChannels.includes(id));

  const aliases = parsed.data.allowed_model_aliases ?? [];
  const existingAliases = await listExistingModelAliases(aliases);
  const droppedAliases = aliases.filter((a) => !existingAliases.includes(a));

  let expiresAt: string | null = parsed.data.expires_at ?? null;
  if (expiresAt) {
    const parsedDate = new Date(expiresAt);
    if (Number.isNaN(parsedDate.getTime())) return jsonError("有效期格式不正确", 400);
    // 与其他时间字段一致，统一存储无时区后缀的 UTC 裸字符串
    expiresAt = toMysqlDatetime(parsedDate);
  }

  const { codes, batchId } = await generateRedeemCodes({
    count: parsed.data.count,
    tokenQuota: parsed.data.token_quota ?? null,
    requestQuota: parsed.data.request_quota ?? null,
    allowedChannelIds: existingChannels,
    allowedModelAliases: existingAliases,
    expiresAt,
    maxUses: parsed.data.max_uses,
    note: parsed.data.note,
    createdBy: guard.auth.user.id,
  });

  return jsonOk({
    message: `已生成 ${codes.length} 个兑换码。`,
    data: { batch_id: batchId, codes },
    ...(droppedChannels.length > 0 ? { warnings: [`以下渠道不存在，已忽略: ${droppedChannels.join(", ")}`] } : {}),
    ...(droppedAliases.length > 0 ? { warnings: [`以下模型别名不存在，已忽略: ${droppedAliases.join(", ")}`] } : {}),
  }, 201);
}

export async function PUT(request: Request) {
  const unavailable = requireFeature("redeemCode");
  if (unavailable) return unavailable;

  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
  const enabled = body?.enabled;

  if (!code || typeof enabled !== "boolean") return jsonError("请求参数不正确", 400);

  const row = await getCodeByCode(code);
  if (!row) return jsonError("兑换码不存在", 404);

  await gatewayDb.execute("UPDATE redeem_codes SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, row.id]);

  return jsonOk({ message: enabled ? "兑换码已启用。" : "兑换码已停用。" });
}

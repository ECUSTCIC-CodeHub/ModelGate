export const dynamic = "force-dynamic";

import { z } from "zod";
import { requireRedeemCodeFeature } from "@/lib/core/features";
import { getGatewaySettings } from "@/lib/core/settings";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { listExistingChannelIds } from "@/lib/gateway/channel-access";
import { listExistingModelAliases } from "@/lib/gateway/model-access";
import { parseExpiresInput, EXPIRES_FUTURE_HINT, generateRedeemCodes, listCodes, getCodeByCode, setRedeemCodesEnabled, deleteRedeemCodes } from "@/lib/services/redeem-codes";

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
  const unavailable = requireRedeemCodeFeature(await getGatewaySettings());
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
  const unavailable = requireRedeemCodeFeature(await getGatewaySettings());
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

  // 空串与纯空白串按「不设有效期」处理：空串本身就是非法时间值，落库后会让核销 SQL 的
  // `expires_at IS NULL OR expires_at > ?` 失去意义（SQLite 下恒不成立、码永远兑换不了，
  // MySQL 严格模式下直接拒写），因此这里与不传该字段等价。
  let expiresAt: string | null = null;
  const rawExpiresAt = parsed.data.expires_at?.trim();
  if (rawExpiresAt) {
    const parsedExpiresAt = parseExpiresInput(rawExpiresAt);
    if (!parsedExpiresAt.ok) return jsonError(parsedExpiresAt.reason, 400);
    if (parsedExpiresAt.time <= Date.now()) return jsonError(EXPIRES_FUTURE_HINT, 400);
    expiresAt = parsedExpiresAt.value;
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

function normalizeCodes(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const raw = (body as Record<string, unknown>).codes;
  return Array.isArray(raw)
    ? raw.filter((c): c is string => typeof c === "string").map((c) => c.trim().toUpperCase()).filter(Boolean)
    : [];
}

export async function PUT(request: Request) {
  const unavailable = requireRedeemCodeFeature(await getGatewaySettings());
  if (unavailable) return unavailable;

  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const enabled = body?.enabled;
  if (typeof enabled !== "boolean") return jsonError("请求参数不正确", 400);

  const codes = normalizeCodes(body);
  const singleCode = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
  if (codes.length === 0 && !singleCode) return jsonError("请求参数不正确", 400);
  if (codes.length > 500) return jsonError("一次最多操作 500 个兑换码", 400);

  const targets = codes.length > 0 ? codes : [singleCode];
  if (codes.length === 0) {
    const row = await getCodeByCode(singleCode);
    if (!row) return jsonError("兑换码不存在", 404);
  }

  const changed = await setRedeemCodesEnabled(targets, enabled);

  return jsonOk({ message: enabled ? `已启用 ${changed} 个兑换码。` : `已停用 ${changed} 个兑换码。` });
}

export async function DELETE(request: Request) {
  const unavailable = requireRedeemCodeFeature(await getGatewaySettings());
  if (unavailable) return unavailable;

  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const codes = normalizeCodes(body);
  const singleCode = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
  if (codes.length === 0 && !singleCode) return jsonError("请求参数不正确", 400);
  if (codes.length > 500) return jsonError("一次最多操作 500 个兑换码", 400);

  const targets = codes.length > 0 ? codes : [singleCode];
  if (codes.length === 0) {
    const row = await getCodeByCode(singleCode);
    if (!row) return jsonError("兑换码不存在", 404);
  }
  const deleted = await deleteRedeemCodes(targets);

  return jsonOk({ message: `已删除 ${deleted} 个兑换码。` });
}

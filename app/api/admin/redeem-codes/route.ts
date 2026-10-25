export const dynamic = "force-dynamic";

import { z } from "zod";
import { requireRedeemCodeFeature } from "@/lib/core/features";
import { getGatewaySettings } from "@/lib/core/settings";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { readJsonBodyCapped } from "@/lib/core/request-body";
import { listExistingChannelIds } from "@/lib/gateway/channel-access";
import { listExistingModelAliases } from "@/lib/gateway/model-access";
import { parseExpiresInput, EXPIRES_FUTURE_HINT, generateRedeemCodes, listCodes, getCodeByCode, setRedeemCodesEnabled, setRedeemBatchEnabled, deleteRedeemCodes, deleteRedeemBatch, listExistingGroupIds } from "@/lib/services/redeem-codes";
import { validatePeriodCycles } from "@/lib/gateway/period-cycles";

const generateSchema = z.object({
  count: z.number().int().min(1).max(1000),
  // 额度券发放定向额度；重置券只清零用户周期用量，不接受额度与周期档配置。
  kind: z.enum(["quota", "reset"]).default("quota"),
  token_quota: z.number().int().min(1).nullable().optional(),
  request_quota: z.number().int().min(1).nullable().optional(),
  period_cycles: z.unknown().optional(),
  allowed_channel_ids: z.array(z.number().int().positive()).optional(),
  allowed_model_aliases: z.array(z.string().min(1)).optional(),
  allowed_group_ids: z.array(z.number().int().positive()).optional(),
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

  const bodyResult = await readJsonBodyCapped(request);
  if (!bodyResult.ok) return jsonError("请求体过大", 413);
  const body = bodyResult.data;
  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const kind = parsed.data.kind;
  if (kind === "reset" && (parsed.data.token_quota != null || parsed.data.request_quota != null)) {
    return jsonError("重置券不发放额度，请留空 Token 额度与请求额度", 400);
  }

  const cyclesResult = validatePeriodCycles(kind === "reset" ? null : parsed.data.period_cycles ?? null);
  if (!cyclesResult.valid) return jsonError(cyclesResult.error, 400);
  const periodCycles = cyclesResult.cycles ?? [];

  if (kind === "quota" && parsed.data.token_quota == null && parsed.data.request_quota == null && periodCycles.length === 0) {
    return jsonError("Token 额度、请求额度与重置周期额度至少填写一项", 400);
  }

  const channelIds = parsed.data.allowed_channel_ids ?? [];
  const existingChannels = await listExistingChannelIds(channelIds);
  const droppedChannels = channelIds.filter((id) => !existingChannels.includes(id));

  const aliases = parsed.data.allowed_model_aliases ?? [];
  const existingAliases = await listExistingModelAliases(aliases);
  const droppedAliases = aliases.filter((a) => !existingAliases.includes(a));

  const groupIds = parsed.data.allowed_group_ids ?? [];
  const existingGroups = await listExistingGroupIds(groupIds);
  const droppedGroups = groupIds.filter((id) => !existingGroups.includes(id));
  // 非空但全部无效时拒绝而非静默落库 "[]"：那会让「限定这些组」变成「对所有人开放」。
  if (groupIds.length > 0 && existingGroups.length === 0) {
    return jsonError("所有限定用户组均不存在，请检查用户组 ID", 400);
  }

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
    kind,
    tokenQuota: parsed.data.token_quota ?? null,
    requestQuota: parsed.data.request_quota ?? null,
    periodCycles,
    allowedChannelIds: existingChannels,
    allowedModelAliases: existingAliases,
    allowedGroupIds: existingGroups,
    expiresAt,
    maxUses: parsed.data.max_uses,
    note: parsed.data.note,
    createdBy: guard.auth.user.id,
  });

  const warnings: string[] = [];
  if (droppedChannels.length > 0) warnings.push(`以下渠道不存在，已忽略: ${[...new Set(droppedChannels)].join(", ")}`);
  if (droppedAliases.length > 0) warnings.push(`以下模型别名不存在，已忽略: ${[...new Set(droppedAliases)].join(", ")}`);
  if (droppedGroups.length > 0) warnings.push(`以下用户组不存在，已忽略: ${[...new Set(droppedGroups)].join(", ")}`);

  return jsonOk({
    message: `已生成 ${codes.length} 个兑换码。`,
    data: { batch_id: batchId, codes },
    ...(warnings.length > 0 ? { warnings } : {}),
  }, 201);
}

type RedeemCodesBody = {
  enabled?: unknown;
  codes?: unknown;
  code?: unknown;
  batch_id?: unknown;
};

function normalizeCodes(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const raw = (body as Record<string, unknown>).codes;
  return Array.isArray(raw)
    ? raw.filter((c): c is string => typeof c === "string").map((c) => c.trim().toUpperCase()).filter(Boolean)
    : [];
}

function normalizeBatchId(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const raw = (body as Record<string, unknown>).batch_id;
  return typeof raw === "string" ? raw.trim() : "";
}

// PUT/DELETE 的目标三选一：codes、code、batch_id，避免一次请求里混用导致语义不明。
function parseRedeemTargets(body: RedeemCodesBody | null):
  | { ok: true; codes: string[]; singleCode: string; batchId: string }
  | { ok: false; message: string } {
  const codes = normalizeCodes(body);
  const singleCode = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
  const batchId = normalizeBatchId(body);

  if (batchId.length > 64) return { ok: false, message: "请求参数不正确" };
  const targetKinds = Number(codes.length > 0) + Number(singleCode.length > 0) + Number(batchId.length > 0);
  if (targetKinds === 0) return { ok: false, message: "请求参数不正确" };
  if (targetKinds > 1) return { ok: false, message: "codes、code、batch_id 只能三选一" };
  if (codes.length > 500) return { ok: false, message: "一次最多操作 500 个兑换码" };

  return { ok: true, codes, singleCode, batchId };
}

export async function PUT(request: Request) {
  const unavailable = requireRedeemCodeFeature(await getGatewaySettings());
  if (unavailable) return unavailable;

  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const bodyResult = await readJsonBodyCapped(request);
  if (!bodyResult.ok) return jsonError("请求体过大", 413);
  const body = bodyResult.data as RedeemCodesBody | null;
  const enabled = body?.enabled;
  if (typeof enabled !== "boolean") return jsonError("请求参数不正确", 400);

  const targetsResult = parseRedeemTargets(body);
  if (!targetsResult.ok) return jsonError(targetsResult.message, 400);
  const { codes, singleCode, batchId } = targetsResult;

  if (batchId) {
    const changed = await setRedeemBatchEnabled(batchId, enabled);
    if (changed === 0) return jsonError("批次不存在", 404);
    return jsonOk({ message: enabled ? `已启用 ${changed} 个兑换码。` : `已停用 ${changed} 个兑换码。` });
  }

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

  const bodyResult = await readJsonBodyCapped(request);
  if (!bodyResult.ok) return jsonError("请求体过大", 413);
  const body = bodyResult.data as RedeemCodesBody | null;
  const targetsResult = parseRedeemTargets(body);
  if (!targetsResult.ok) return jsonError(targetsResult.message, 400);
  const { codes, singleCode, batchId } = targetsResult;

  if (batchId) {
    const deleted = await deleteRedeemBatch(batchId);
    if (deleted === 0) return jsonError("批次不存在", 404);
    return jsonOk({ message: `已删除 ${deleted} 个兑换码。` });
  }

  const targets = codes.length > 0 ? codes : [singleCode];
  if (codes.length === 0) {
    const row = await getCodeByCode(singleCode);
    if (!row) return jsonError("兑换码不存在", 404);
  }
  const deleted = await deleteRedeemCodes(targets);

  return jsonOk({ message: `已删除 ${deleted} 个兑换码。` });
}

export const dynamic = "force-dynamic";

import { z } from "zod";
import { requireRedeemCodeFeature } from "@/lib/core/features";
import { getGatewaySettings } from "@/lib/core/settings";
import { ensureUser } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { readJsonBodyCapped } from "@/lib/core/request-body";
import { gatewayDb } from "@/lib/core/db";
import { redeemCodeForUser, listUserBalances } from "@/lib/services/redeem-codes";
import { parseAllowedChannelIds } from "@/lib/gateway/channel-access";
import { parseAllowedModelAliases } from "@/lib/gateway/model-access";
import { parsePeriodCycles } from "@/lib/gateway/period-cycles";
import { toPeriodQuotaEntry } from "@/lib/gateway/quota";

const redeemSchema = z.object({
  code: z.string().min(1).max(64),
});

export async function GET(request: Request) {
  const settings = await getGatewaySettings();
  const unavailable = requireRedeemCodeFeature(settings);
  if (unavailable) return unavailable;

  const guard = await ensureUser(request);
  if ("error" in guard) return guard.error;

  const balances = (await listUserBalances(guard.auth.user.id)).map((balance) => ({
    ...balance,
    allowed_channel_ids: parseAllowedChannelIds(balance.allowed_channel_ids),
    allowed_model_aliases: parseAllowedModelAliases(balance.allowed_model_aliases),
  }));

  // 补充兑换记录与渠道/模型可读信息
  const redemptions = await gatewayDb.query<Record<string, unknown>>(
    `SELECT r.id, r.code_id, r.redeemed_at, c.code, c.token_quota, c.request_quota, c.period_cycles
       FROM redeem_redemptions r
       LEFT JOIN redeem_codes c ON c.id = r.code_id
       WHERE r.user_id = ?
       ORDER BY r.id DESC`,
    [guard.auth.user.id],
  );

  return jsonOk({ data: balances, redemptions });
}

export async function POST(request: Request) {
  const unavailable = requireRedeemCodeFeature(await getGatewaySettings());
  if (unavailable) return unavailable;

  const guard = await ensureUser(request);
  if ("error" in guard) return guard.error;

  const body = await readJsonBodyCapped(request);
  if (!body.ok) return jsonError("请求体过大", 413);
  const parsed = redeemSchema.safeParse(body.data);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const result = await redeemCodeForUser(guard.auth.user.id, parsed.data.code);
  if (!result.ok) {
    return jsonError(result.reason, 400);
  }

  // 重置券不发额度，只回执重置结果；响应形状与额度券区分开，前端据此提示。
  if (result.balance === null) {
    return jsonOk({
      message: "周期用量已重置。",
      data: { kind: "reset", reset: true },
    }, 201);
  }

  const balance = result.balance;
  return jsonOk({
    message: "兑换成功。",
    data: {
      ...balance,
      kind: "quota",
      allowed_channel_ids: parseAllowedChannelIds(balance.allowed_channel_ids),
      allowed_model_aliases: parseAllowedModelAliases(balance.allowed_model_aliases),
      remaining_tokens: balance.token_quota !== null ? Math.max(0, balance.token_quota - balance.used_tokens) : null,
      remaining_requests: balance.request_quota !== null ? Math.max(0, balance.request_quota - balance.used_requests) : null,
      periods: parsePeriodCycles(balance.period_cycles).map(toPeriodQuotaEntry),
      // 与 GET /api/user/redeem 保持同一形状：核销成功即代表该额度当下有效
      active: true,
      inactive_reason: null,
    },
  }, 201);
}

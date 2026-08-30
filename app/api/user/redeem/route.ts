export const dynamic = "force-dynamic";

import { z } from "zod";
import { requireFeature } from "@/lib/core/features";
import { ensureUser } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";
import { redeemCodeForUser, listUserBalances } from "@/lib/services/redeem-codes";
import { parseAllowedChannelIds } from "@/lib/gateway/channel-access";
import { parseAllowedModelAliases } from "@/lib/gateway/model-access";

const redeemSchema = z.object({
  code: z.string().min(1).max(64),
});

export async function GET(request: Request) {
  const unavailable = requireFeature("redeemCode");
  if (unavailable) return unavailable;

  const guard = await ensureUser(request);
  if ("error" in guard) return guard.error;

  const balances = await listUserBalances(guard.auth.user.id);

  // 补充兑换记录与渠道/模型可读信息
  const redemptions = await gatewayDb.query<Record<string, unknown>>(
    `SELECT r.id, r.code_id, r.redeemed_at, c.code, c.token_quota, c.request_quota
       FROM redeem_redemptions r
       LEFT JOIN redeem_codes c ON c.id = r.code_id
       WHERE r.user_id = ?
       ORDER BY r.id DESC`,
    [guard.auth.user.id],
  );

  return jsonOk({
    data: balances.map((b) => ({
      ...b,
      allowed_channel_ids: parseAllowedChannelIds(b.allowed_channel_ids),
      allowed_model_aliases: parseAllowedModelAliases(b.allowed_model_aliases),
    })),
    redemptions,
  });
}

export async function POST(request: Request) {
  const unavailable = requireFeature("redeemCode");
  if (unavailable) return unavailable;

  const guard = await ensureUser(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = redeemSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const result = await redeemCodeForUser(guard.auth.user.id, parsed.data.code);
  if (!result.ok) {
    return jsonError(result.reason, 400);
  }

  const balance = result.balance;
  return jsonOk({
    message: "兑换成功。",
    data: {
      ...balance,
      allowed_channel_ids: parseAllowedChannelIds(balance.allowed_channel_ids),
      allowed_model_aliases: parseAllowedModelAliases(balance.allowed_model_aliases),
      remaining_tokens: balance.token_quota !== null ? Math.max(0, balance.token_quota - balance.used_tokens) : null,
      remaining_requests: balance.request_quota !== null ? Math.max(0, balance.request_quota - balance.used_requests) : null,
    },
  }, 201);
}

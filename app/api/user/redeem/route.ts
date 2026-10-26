export const dynamic = "force-dynamic";

import { z } from "zod";
import { requireRedeemCodeFeature } from "@/lib/core/features";
import { getGatewaySettings } from "@/lib/core/settings";
import { ensureUser } from "@/lib/auth/guards";
import { dbCapacityResponse, jsonError, jsonOk } from "@/lib/core/http";
import { readJsonBodyCapped } from "@/lib/core/request-body";
import { gatewayDb } from "@/lib/core/db";
import { resolveClientIp } from "@/lib/core/client-ip";
import { redeemCodeForUser, listUserBalances } from "@/lib/services/redeem-codes";
import { parseAllowedChannelIds } from "@/lib/gateway/channel-access";
import { parseAllowedModelAliases } from "@/lib/gateway/model-access";
import { parsePeriodCycles } from "@/lib/gateway/period-cycles";
import { toPeriodQuotaEntry } from "@/lib/gateway/quota";

const redeemSchema = z.object({
  code: z.string().min(1).max(64),
});

// 兑换限流状态放在进程内存：IP 维度、60 秒滑动窗口 10 次，第 11 次起拒绝。
// Map 设键数上界并按插入序淘汰最旧键：伪造 IP 洪泛时内存有界，正常流量不受影响。
const attempts = new Map<string, number[]>();

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 60_000;
const CLEANUP_INTERVAL_MS = 300_000;
const MAX_KEYS = 10_000;

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of attempts) {
    const alive = timestamps.filter((ts) => now - ts < WINDOW_MS);
    if (alive.length === 0) attempts.delete(key);
    else attempts.set(key, alive);
  }
}, CLEANUP_INTERVAL_MS).unref();

function evictOldestKeys() {
  while (attempts.size > MAX_KEYS) {
    const oldest = attempts.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    attempts.delete(oldest);
  }
}

function checkRedeemRateLimit(request: Request): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const key = resolveClientIp(request.headers) ?? "unknown";
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((ts) => now - ts < WINDOW_MS);

  if (recent.length >= MAX_ATTEMPTS) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000)) };
  }

  recent.push(now);
  attempts.delete(key);
  attempts.set(key, recent);
  evictOldestKeys();
  return { ok: true };
}

export async function GET(request: Request) {
  const settings = await getGatewaySettings();
  const unavailable = requireRedeemCodeFeature(settings);
  if (unavailable) return unavailable;

  const guard = await ensureUser(request);
  if ("error" in guard) return guard.error;

  try {
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
  } catch (err) {
    const busy = dbCapacityResponse(err);
    if (busy) return busy;
    throw err;
  }
}

export async function POST(request: Request) {
  const unavailable = requireRedeemCodeFeature(await getGatewaySettings());
  if (unavailable) return unavailable;

  // 限流先于鉴权：未认证的穷举探测同样消耗额度。
  const rate = checkRedeemRateLimit(request);
  if (!rate.ok) {
    return jsonError("兑换请求过于频繁，请稍后再试", 429, {}, { "retry-after": String(rate.retryAfterSeconds) });
  }

  const guard = await ensureUser(request);
  if ("error" in guard) return guard.error;

  const body = await readJsonBodyCapped(request);
  if (!body.ok) return jsonError("请求体过大", 413);
  const parsed = redeemSchema.safeParse(body.data);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  let result: Awaited<ReturnType<typeof redeemCodeForUser>>;
  try {
    result = await redeemCodeForUser(guard.auth.user.id, parsed.data.code);
  } catch (err) {
    const busy = dbCapacityResponse(err);
    if (busy) return busy;
    throw err;
  }
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

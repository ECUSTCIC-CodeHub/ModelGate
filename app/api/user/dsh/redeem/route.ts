export const dynamic = "force-dynamic";

import { z } from "zod";
import { jsonError, jsonOk, dbCapacityResponse } from "@/lib/core/http";
import { readJsonBodyCapped } from "@/lib/core/request-body";
import { resolveClientIp } from "@/lib/core/client-ip";
import { redeemEnrollCode } from "@/lib/services/dsh-enroll";

const redeemSchema = z.object({
  code: z.string().min(1).max(64),
});

// 兑换限流：IP 维度、60 秒滑动窗口 10 次。与 /api/user/redeem 同款实现。
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

function checkRateLimit(request: Request): { ok: true } | { ok: false; retryAfterSeconds: number } {
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

export async function POST(request: Request) {
  // 限流先于一切：未认证的穷举探测同样消耗额度。
  const rate = checkRateLimit(request);
  if (!rate.ok) {
    return jsonError("兑换请求过于频繁，请稍后再试", 429, {}, { "retry-after": String(rate.retryAfterSeconds) });
  }

  const body = await readJsonBodyCapped(request);
  if (!body.ok) return jsonError("请求体过大", 413);
  const parsed = redeemSchema.safeParse(body.data);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  try {
    const result = await redeemEnrollCode(parsed.data.code);
    if (!result.ok) {
      return jsonError(result.reason, 400);
    }

    return jsonOk({
      message: "兑换成功。",
      data: {
        key: result.key,
        key_id: result.keyId,
      },
    }, 200);
  } catch (err) {
    const busy = dbCapacityResponse(err);
    if (busy) return busy;
    throw err;
  }
}

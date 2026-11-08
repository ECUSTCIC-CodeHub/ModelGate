export const dynamic = "force-dynamic";

import { z } from "zod";
import { requireWebAuth } from "@/lib/auth/auth";
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

/**
 * 兑换只认 code 本身，不要求登录：DSH 从本机回调拿到码后直接来换，
 * 带的是 DSH 自己的凭据而不是浏览器 Cookie。可选登录态只用来收紧绑定。
 *
 * 响应形状刻意做成扁平的 { key, key_id } / { error: { message } }：
 * 这是插件 gatewayJson 读取的形状（body.key、body.error.message），
 * 与本站其他接口的 { message, data } 信封不同，改动前先看插件实现。
 */
export async function POST(request: Request) {
  // 限流先于一切：未认证的穷举探测同样消耗额度。
  const rate = checkRateLimit(request);
  if (!rate.ok) {
    return jsonError("兑换请求过于频繁，请稍后再试", 429, {}, { "retry-after": String(rate.retryAfterSeconds) });
  }

  const body = await readJsonBodyCapped(request);
  if (!body.ok) return jsonError("请求体过大", 413);
  const parsed = redeemSchema.safeParse(body.data ?? null);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  try {
    // 可选登录态只用来收紧绑定：DSH 本机回调不带浏览器 Cookie，所以这里不能强制登录。
    // 走 requireWebAuth 而不是自己解 token，AUTH_DISABLED 模式下才会得到同一个匿名用户。
    const auth = await requireWebAuth(request);
    const result = await redeemEnrollCode(parsed.data.code, auth?.user.id ?? null);
    if (!result.ok) return jsonError(result.reason, 400);

    return jsonOk({ key: result.key, key_id: result.keyId }, 200);
  } catch (err) {
    const busy = dbCapacityResponse(err);
    if (busy) return busy;
    console.error("[dsh] 兑换授权码失败", err);
    return jsonError("兑换失败，请稍后重试", 500);
  }
}

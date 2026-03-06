import type { DbUser } from "@/lib/db";

type Bucket = {
  tokens: number;
  lastRefillMs: number;
};

const buckets = new Map<string, Bucket>();

function takeToken(bucketKey: string, capacity: number, refillPerWindow: number, windowMs: number, amount = 1): boolean {
  const now = Date.now();
  const refillPerMs = refillPerWindow / windowMs;
  const existing = buckets.get(bucketKey) ?? { tokens: capacity, lastRefillMs: now };

  const elapsed = Math.max(0, now - existing.lastRefillMs);
  const refilled = Math.min(capacity, existing.tokens + elapsed * refillPerMs);

  if (refilled < amount) {
    buckets.set(bucketKey, { tokens: refilled, lastRefillMs: now });
    return false;
  }

  buckets.set(bucketKey, { tokens: refilled - amount, lastRefillMs: now });
  return true;
}

export function checkUserRateLimit(user: DbUser, estimatedTokens: number) {
  const userPrefix = `user:${user.id}`;

  const rpmOk = takeToken(`${userPrefix}:rpm`, Math.max(1, user.rpm), Math.max(1, user.rpm), 60000, 1);
  if (!rpmOk) {
    return { ok: false, reason: "RPM exceeded" };
  }

  const qpsOk = takeToken(`${userPrefix}:qps`, Math.max(1, user.qps), Math.max(1, user.qps), 1000, 1);
  if (!qpsOk) {
    return { ok: false, reason: "QPS exceeded" };
  }

  const tpmNeed = Math.max(1, estimatedTokens);
  const tpmOk = takeToken(`${userPrefix}:tpm`, Math.max(1, user.tpm), Math.max(1, user.tpm), 60000, tpmNeed);
  if (!tpmOk) {
    return { ok: false, reason: "TPM exceeded" };
  }

  return { ok: true as const };
}

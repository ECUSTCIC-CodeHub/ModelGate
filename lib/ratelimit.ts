import type { DbUser } from "@/lib/db";
import { getEffectiveLimits } from "@/lib/effective-limits";

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
  const limits = getEffectiveLimits(user);
  const userPrefix = `user:${user.id}`;

  if (limits.rpm >= 0) {
    const rpmOk = takeToken(`${userPrefix}:rpm`, limits.rpm, limits.rpm, 60000, 1);
    if (!rpmOk) {
      return { ok: false, reason: "RPM 超限" };
    }
  }

  if (limits.qps >= 0) {
    const qpsOk = takeToken(`${userPrefix}:qps`, limits.qps, limits.qps, 1000, 1);
    if (!qpsOk) {
      return { ok: false, reason: "QPS 超限" };
    }
  }

  if (limits.tpm >= 0) {
    const tpmNeed = Math.max(1, estimatedTokens);
    const tpmOk = takeToken(`${userPrefix}:tpm`, limits.tpm, limits.tpm, 60000, tpmNeed);
    if (!tpmOk) {
      return { ok: false, reason: "TPM 超限" };
    }
  }

  return { ok: true as const };
}

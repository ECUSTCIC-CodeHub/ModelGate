const usedCodes = new Map<string, number>();

const CLEANUP_INTERVAL_MS = 120_000;
const MAX_ENTRY_AGE_MS = 120_000;

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of usedCodes) {
    if (now - ts > MAX_ENTRY_AGE_MS) usedCodes.delete(key);
  }
}, CLEANUP_INTERVAL_MS).unref();

export function isTotpCodeReplayed(userId: number, code: string): boolean {
  const key = `${userId}:${code}`;
  return usedCodes.has(key);
}

export function markTotpCodeUsed(userId: number, code: string): void {
  const key = `${userId}:${code}`;
  usedCodes.set(key, Date.now());
}

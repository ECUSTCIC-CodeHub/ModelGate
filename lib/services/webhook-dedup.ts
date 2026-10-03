const WEBHOOK_DEDUP_RETENTION_MS = 15 * 60 * 1000;
const WEBHOOK_DEDUP_MAX_ENTRIES = 10000;

const seenEvents = new Map<string, number>();
let lastSweep = Date.now();

function sweep(now: number) {
  for (const [id, expiry] of seenEvents) {
    if (expiry <= now) seenEvents.delete(id);
  }
  // 预留一个空位，保证随后的插入不会让表超过上限
  while (seenEvents.size >= WEBHOOK_DEDUP_MAX_ENTRIES) {
    const oldest = seenEvents.keys().next();
    if (oldest.done) break;
    seenEvents.delete(oldest.value);
  }
  lastSweep = now;
}

export function isWebhookEventDuplicate(eventId: string): boolean {
  if (!eventId) return false;
  const now = Date.now();
  if (now - lastSweep >= WEBHOOK_DEDUP_RETENTION_MS) sweep(now);

  const expiry = seenEvents.get(eventId);
  if (expiry !== undefined && expiry > now) return true;
  // 未到清扫周期也可能已满，插入前再兜一次容量，避免窗口内无界增长
  if (seenEvents.size >= WEBHOOK_DEDUP_MAX_ENTRIES) sweep(now);
  seenEvents.set(eventId, now + WEBHOOK_DEDUP_RETENTION_MS);
  return false;
}

export function forgetWebhookEvent(eventId: string): void {
  if (!eventId) return;
  seenEvents.delete(eventId);
}

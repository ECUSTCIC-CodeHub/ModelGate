export function formatDuration(ms: number | null | undefined) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(2)} s`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(2)} m`;
  return `${(min / 60).toFixed(2)} h`;
}

export function quotaProgress(remaining: number | null, quota: number | null) {
  if (typeof remaining !== "number" || typeof quota !== "number" || quota <= 0) return 0;
  return Math.max(0, Math.min(100, (remaining / quota) * 100));
}

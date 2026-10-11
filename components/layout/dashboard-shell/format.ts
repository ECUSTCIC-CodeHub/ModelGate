export function formatLimit(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  if (value < 0) return "∞";
  const display = Math.abs(value - Math.round(value)) < 1e-6 ? Math.round(value) : value;
  const abs = Math.abs(display);
  if (abs >= 1_000_000_000) return `${(display / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(display / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(display / 1_000).toFixed(1)}k`;
  return String(display);
}

export function getApiMessage(data: unknown, fallback: string) {
  if (!data || typeof data !== "object") return fallback;
  const obj = data as Record<string, unknown>;
  if (typeof obj.message === "string" && obj.message.trim()) return obj.message;
  const error = obj.error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

export function getApiWarnings(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.warnings)) return [];
  return obj.warnings.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

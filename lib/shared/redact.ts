export const MASKED_SECRET = "****";

export function maskApiKey(key: string | null | undefined): string | null {
  if (key === null || key === undefined) return null;
  if (key === "") return "";
  if (key.length <= 8) return MASKED_SECRET;
  return `${MASKED_SECRET}${key.slice(-4)}`;
}

export function isMaskedApiKey(value: string, existing: string | null | undefined): boolean {
  return value === maskApiKey(existing ?? "");
}

export function resolveSubmittedApiKey(input: string | undefined, existing: string): string {
  if (input === undefined || input === "") return existing;
  if (isMaskedApiKey(input, existing)) return existing;
  return input;
}

export function redactUrlCredentials(input: string): string {
  return input.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]*@/g, "$1");
}

export function redactErrorMessage(error: unknown, fallback = "未知错误"): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return redactUrlCredentials(raw.trim() || fallback);
}

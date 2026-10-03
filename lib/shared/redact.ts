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

export function resolveSubmittedApiKey(
  input: string | undefined,
  existing: string | null,
  options?: { clearOnEmpty?: boolean },
): string | null {
  if (input === undefined) return existing;
  if (input === "") return options?.clearOnEmpty ? "" : existing;
  if (isMaskedApiKey(input, existing)) return existing;
  return input;
}

export function redactUrlCredentials(input: string): string {
  // userinfo 允许出现 @（如 user:pa@ss），故这里必须允许跨过 @、只禁止跨过路径分隔符，
  // 否则贪婪回溯只会删到第一个 @，把密码后半段留在明文里。
  return input.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s]*@/g, "$1");
}

export function redactErrorMessage(error: unknown, fallback = "未知错误"): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return redactUrlCredentials(raw.trim() || fallback);
}

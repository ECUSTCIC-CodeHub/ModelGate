export function resolveSafeNext(param: string | null | undefined, fallback = "/dashboard"): string {
  if (!param) return fallback;
  if (!param.startsWith("/") || param.startsWith("//")) return fallback;
  // URL 解析器会把反斜杠当作正斜杠、并在解析前移除 tab/LF/CR 等控制字符，
  // 拒绝它们以防 "/\evil.com"、"/%09/evil.com" 等载荷绕过开放重定向校验。
  if (/[\u0000-\u001F\u007F\\]/.test(param)) return fallback;

  let url: URL;
  try {
    url = new URL(param, "https://safe.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "https://safe.invalid") return fallback;
  const normalized = url.pathname + url.search + url.hash;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return fallback;
  }
  if (/[\u0000-\u001F\u007F\\]/.test(decodedPath)) return fallback;
  if (
    decodedPath === "/login" ||
    decodedPath.startsWith("/login?") ||
    decodedPath === "/register" ||
    decodedPath.startsWith("/register?")
  ) {
    return fallback;
  }
  return normalized;
}

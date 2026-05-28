function firstHeaderValue(value: string | null) {
  const first = value?.split(",")[0]?.trim();
  return first || null;
}

export function resolveClientIp(headers: Headers): string | null {
  return firstHeaderValue(headers.get("eo-client-ip"))
    ?? firstHeaderValue(headers.get("x-forwarded-for"))
    ?? firstHeaderValue(headers.get("x-real-ip"));
}

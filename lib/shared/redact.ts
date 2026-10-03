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

// userinfo 允许出现 @（如 user:pa@ss），所以要去掉的是 authority 段里最后一个 @ 及其之前的内容；
// query/hash 不参与，否则正文里的 https://x.com?next=mailto:a@b.com 会被误删。
// 用逐字符扫描而非正则：正则在无 @ 的长文本上需反复回溯，耗时随长度超线性增长
// （实测 20 万字符达 44 秒），而这里的输入来自上游响应体，长度不可控。
const SCHEME_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*$/;

function isAuthorityTerminator(char: string): boolean {
  return char === "/" || char === "?" || char === "#" || char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}

export function redactUrlCredentials(input: string): string {
  let result = "";
  let index = 0;
  while (index < input.length) {
    const colonAt = input.indexOf("://", index);
    if (colonAt === -1) {
      result += input.slice(index);
      break;
    }

    // 方案名紧邻 ://，最多 63 字符，且必须以字母开头
    let schemeStart = colonAt;
    while (schemeStart > index && /[a-zA-Z0-9+.-]/.test(input[schemeStart - 1])) schemeStart -= 1;
    const schemeName = input.slice(schemeStart, colonAt);
    if (schemeName.length === 0 || schemeName.length > 63 || !SCHEME_NAME_PATTERN.test(schemeName)) {
      result += input.slice(index, colonAt + 3);
      index = colonAt + 3;
      continue;
    }

    const authorityStart = colonAt + 3;
    let cursor = authorityStart;
    let lastAt = -1;
    while (cursor < input.length && !isAuthorityTerminator(input[cursor])) {
      if (input[cursor] === "@") lastAt = cursor;
      cursor += 1;
    }

    result += input.slice(index, authorityStart);
    // 有 userinfo 时丢弃其整段，只保留 @ 之后的主机部分；否则原样保留 authority
    result += lastAt === -1 ? input.slice(authorityStart, cursor) : input.slice(lastAt + 1, cursor);
    index = cursor;
  }
  return result;
}

export function redactErrorMessage(error: unknown, fallback = "未知错误"): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return redactUrlCredentials(raw.trim() || fallback);
}

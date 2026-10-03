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

// 与旧正则 ([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#\s]*@ 语义一致：
// 从左到右找「方案名 + ://」，再看其后到 / ? # 空白为止的这一段里是否有 @；
// 有则删掉 :// 之后到最后一个 @ 为止的内容（userinfo 允许含 @，必须删到最后一个），
// 没有则不匹配，从 :// 之后继续找下一个候选。
// 用逐字符扫描而非正则：正则在无 @ 的长文本上需反复回溯，耗时随长度超线性增长
// （实测 20 万字符达 44 秒），而这里的输入来自上游响应体，长度不可控。
const SCHEME_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*$/;

function isUrlTerminator(char: string): boolean {
  return char === "/" || char === "?" || char === "#" || char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}

export function redactUrlCredentials(input: string): string {
  if (!input.includes("://")) return input;

  let result = "";
  let index = 0;
  while (index < input.length) {
    const colonAt = input.indexOf("://", index);
    if (colonAt === -1) {
      result += input.slice(index);
      break;
    }

    // 方案名紧邻 ://，最多 63 字符且必须以字母开头；不满足则跳过这个 ://
    let schemeStart = colonAt;
    while (schemeStart > index && /[a-zA-Z0-9+.-]/.test(input[schemeStart - 1])) schemeStart -= 1;
    const schemeName = input.slice(schemeStart, colonAt);
    if (schemeName.length === 0 || schemeName.length > 63 || !SCHEME_NAME_PATTERN.test(schemeName)) {
      result += input.slice(index, colonAt + 3);
      index = colonAt + 3;
      continue;
    }

    const authorityStart = colonAt + 3;
    let lastAt = -1;
    let cursor = authorityStart;
    while (cursor < input.length && !isUrlTerminator(input[cursor])) {
      if (input[cursor] === "@") lastAt = cursor;
      cursor += 1;
    }

    if (lastAt === -1) {
      // 本段没有 @，该方案不构成带凭据的 URL：只输出到 ://，此后从 :// 之后继续找，
      // 这样 https://a://b@c 里内层的 a:// 才会被当作新候选识别到
      result += input.slice(index, authorityStart);
      index = authorityStart;
      continue;
    }

    // 与旧正则一致：删除 :// 之后到本段最后一个 @ 为止的内容（userinfo 允许含 @），
    // 然后从 @ 之后继续扫描——而不是跳到段尾。段内若还嵌着下一个 URL 的 ://，
    // 跳到段尾会把它的凭据连同连接文本一起原样输出
    result += input.slice(index, authorityStart);
    index = lastAt + 1;
  }
  return result;
}

export function redactErrorMessage(error: unknown, fallback = "未知错误"): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return redactUrlCredentials(raw.trim() || fallback);
}

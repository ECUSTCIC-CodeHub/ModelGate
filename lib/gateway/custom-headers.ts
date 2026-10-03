// 自定义 Header 会附加到该渠道的所有上游请求（真实转发、模型测试、模型列表探测）。
// 其中一部分头部由网关托管，允许覆盖会破坏鉴权或让请求体与声明不符，故列入黑名单，
// 大小写不敏感地拒绝。
const BLOCKED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "via",
  "te",
  "trailer",
  "cookie",
  "content-type",
  "user-agent",
  "anthropic-version",
  "anthropic-beta",
  "accept-encoding",
]);

export const CUSTOM_HEADER_MAX_ENTRIES = 20;
export const CUSTOM_HEADER_NAME_MAX_LENGTH = 128;
export const CUSTOM_HEADER_VALUE_MAX_LENGTH = 2048;

// HTTP token 允许的字符集合（RFC 9110）
const HEADER_NAME_PATTERN = /^[a-zA-Z0-9!#$%&'*+\-.^_`|~]+$/;

// 值里的换行会破坏「每行一条」的编辑形态而无法再保存，其它控制字符与 NEL/NBSP
// 虽能被 Headers 接受但语义可疑，一并拦下。制表符是合法 header 值，放行
const UNDESIRABLE_VALUE_PATTERN = /[\u0000-\u0008\u000a-\u001f\u007f-\u00a0\u2028\u2029]/;

// 不以字符区间去判断「可用性」：undici 的 Headers.set 对任何非 Latin-1 字符
// （U+0100 以上，含中日韩文与 emoji）都会抛 ByteString 错误，手写区间必然漏字符。
// 直接用 Headers 做一次真实往返，它是唯一权威的判据
function isUsableHeader(name: string, value: string): boolean {
  try {
    new Headers().set(name, value);
    return true;
  } catch {
    return false;
  }
}

export type CustomHeaders = Record<string, string>;

export type CustomHeadersResult =
  | { ok: true; headers: CustomHeaders }
  | { ok: false; error: string };

// 保存与探测都先归一化：名称与值的首尾空白若落库，Set 时会因非法字符导致请求失败
export function normalizeCustomHeaderName(name: string): string {
  return name.trim();
}

function entriesOf(value: unknown): Array<[string, string]> | null {
  if (value === null || value === undefined) return [];
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const entries: Array<[string, string]> = [];
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue !== "string") return null;
    entries.push([rawName, rawValue]);
  }
  return entries;
}

export function validateCustomHeaders(value: unknown): CustomHeadersResult {
  const entries = entriesOf(value);
  if (entries === null) return { ok: false, error: "自定义 Header 必须是键值对对象" };

  const pairs = entries.filter(([name]) => normalizeCustomHeaderName(name) !== "");
  if (pairs.length > CUSTOM_HEADER_MAX_ENTRIES) {
    return { ok: false, error: `自定义 Header 最多 ${CUSTOM_HEADER_MAX_ENTRIES} 对` };
  }

  const headers: CustomHeaders = {};
  for (const [rawName, rawValue] of pairs) {
    const name = normalizeCustomHeaderName(rawName);
    if (name.length > CUSTOM_HEADER_NAME_MAX_LENGTH || !HEADER_NAME_PATTERN.test(name)) {
      return { ok: false, error: `自定义 Header 名称不合法或超过 ${CUSTOM_HEADER_NAME_MAX_LENGTH} 字符：${name}` };
    }
    if (BLOCKED_HEADERS.has(name.toLowerCase())) {
      return { ok: false, error: `自定义 Header 不允许配置 ${name}` };
    }
    const trimmedValue = rawValue.trim();
    if (trimmedValue.length > CUSTOM_HEADER_VALUE_MAX_LENGTH) {
      return { ok: false, error: `自定义 Header ${name} 的值超过 ${CUSTOM_HEADER_VALUE_MAX_LENGTH} 字符` };
    }
    // 值里的换行会破坏「每行一条」的编辑形态而无法再保存，非 Latin-1 字符会让
    // Headers.set 抛错并被上游兜成 502 且永久不自愈，两者都在保存时拦下
    if (UNDESIRABLE_VALUE_PATTERN.test(trimmedValue) || !isUsableHeader(name, trimmedValue)) {
      return { ok: false, error: `自定义 Header ${name} 的值包含换行、控制字符或非 Latin-1 字符` };
    }
    headers[name] = trimmedValue;
  }

  return { ok: true, headers };
}

// 存储为 JSON 字符串，读回时容错：历史数据或手工改坏的值都不抛错。
// 逐键过滤而不是整份丢弃：脏数据里混入一个黑名单键时，其余合法项仍应继续生效
export function parseCustomHeaders(raw: unknown): CustomHeaders {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const headers: CustomHeaders = {};
  for (const [rawName, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof rawValue !== "string") continue;
    // 逐键调用会绕过整份校验的条数上限，这里显式再兜一次
    if (Object.keys(headers).length >= CUSTOM_HEADER_MAX_ENTRIES) break;
    const result = validateCustomHeaders({ [rawName]: rawValue });
    if (result.ok) Object.assign(headers, result.headers);
  }
  return headers;
}

export function stringifyCustomHeaders(headers: CustomHeaders): string {
  return Object.keys(headers).length === 0 ? "" : JSON.stringify(headers);
}

// overwrite=false 用于真实转发：托管字段（Content-Type、x-api-key 等）晚于本函数设置，永远胜出；
// overwrite=true 用于 other 透传，自定义 Header 需要覆盖客户端同名透传值
export function applyCustomHeaders(target: Headers, headers: CustomHeaders, overwrite: boolean): void {
  for (const [name, value] of Object.entries(headers)) {
    if (!overwrite && target.has(name)) continue;
    target.set(name, value);
  }
}

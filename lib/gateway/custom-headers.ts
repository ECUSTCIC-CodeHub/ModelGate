// 网关托管的头部：允许覆盖会破坏鉴权、让请求体与声明不符或让网络层改写请求。
const MANAGED_HEADERS = [
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
];

// 转发链元数据：request_body_omit 支持剔除 metadata 说明上游会在意这类字段，
// 而 header_mappings 的值由客户端控制。上游若按它们做 IP 白名单、绝对 URL 生成
// 或同源校验，映射就成了提权通道，因此与托管头一起拒绝。
const FORWARDING_METADATA_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-server",
  "x-real-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "fastly-client-ip",
  "x-original-url",
  "x-rewrite-url",
  "x-original-forwarded-for",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
];

// 自定义 Header 会附加到该渠道的所有上游请求（真实转发、模型测试、模型列表探测），
// 请求头映射的值还来自客户端，两处共用同一份黑名单与运行期拦截
const BLOCKED_HEADERS = new Set([...MANAGED_HEADERS, ...FORWARDING_METADATA_HEADERS]);

export const CUSTOM_HEADER_MAX_ENTRIES = 20;
export const HEADER_MAPPING_MAX_ENTRIES = 10;
export const CUSTOM_HEADER_NAME_MAX_LENGTH = 128;
export const CUSTOM_HEADER_VALUE_MAX_LENGTH = 2048;

// HTTP token 允许的字符集合（RFC 9110 token）
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

// 请求头映射：把客户端请求里的某个头改名后发往上游，用于不同客户端/上游对同一语义
// 使用不同头名的场景（如客户端的 X-Session-Id 映射成上游要的 X-Opencode-Session）。
// 纯重命名，值始终取自客户端，因此不能借它伪造鉴权头
export type HeaderMapping = { from: string; to: string };

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

function isValidHeaderName(name: string): boolean {
  return name.length > 0 && name.length <= CUSTOM_HEADER_NAME_MAX_LENGTH && HEADER_NAME_PATTERN.test(name);
}

// 源与目标写反是这套配置最常见的笔误，而写反时值永远取不到、表现为「配了没生效」。
// 但两端都强制带连字符会误伤真实头名（referer、origin、traceparent 都无连字符，
// 而它们改名恰恰是映射的典型用途），故收敛为「任一端带连字符」：写反时仍会命中，
// 因为另一端仍是另一个真实头名、通常也不带连字符
function looksLikeHeaderName(name: string): boolean {
  return name.includes("-");
}

function hasHyphenOnEitherSide(source: string, target: string): boolean {
  return looksLikeHeaderName(source) || looksLikeHeaderName(target);
}

export type HeaderMappingResult =
  | { ok: true; mappings: HeaderMapping[] }
  | { ok: false; error: string };

// 源与目标都必须是合法 token，目标还不能是网关托管头：映射的值来自客户端，
// 允许写进 Authorization 等于给了客户端绕过渠道密钥的通道
export function validateHeaderMappings(value: unknown): HeaderMappingResult {
  if (value === undefined || value === null) return { ok: true, mappings: [] };
  if (!Array.isArray(value)) return { ok: false, error: "请求头映射需为对象数组" };
  if (value.length > HEADER_MAPPING_MAX_ENTRIES) {
    return { ok: false, error: `请求头映射最多 ${HEADER_MAPPING_MAX_ENTRIES} 项` };
  }

  const mappings: HeaderMapping[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "请求头映射需为对象数组" };
    }
    const { from, to } = item as Record<string, unknown>;
    if (typeof from !== "string" || typeof to !== "string") {
      return { ok: false, error: "请求头映射的源与目标都必须是字符串" };
    }
    const source = normalizeCustomHeaderName(from);
    const target = normalizeCustomHeaderName(to);
    if (!isValidHeaderName(source) || !isValidHeaderName(target)) {
      return { ok: false, error: `请求头映射的名称不合法或超过 ${CUSTOM_HEADER_NAME_MAX_LENGTH} 字符：${source || target}` };
    }
    if (!hasHyphenOnEitherSide(source, target)) {
      return { ok: false, error: `请求头映射的源与目标至少一端需是带连字符的 HTTP 头名（两端都不带，很可能是源与目标写反了）：${source} -> ${target}` };
    }
    if (BLOCKED_HEADERS.has(target.toLowerCase())) {
      return { ok: false, error: `请求头映射的目标不允许是 ${target}` };
    }
    // 同名映射是无意义配置，留着只会让管理员误以为做了什么；键名大小写不敏感地判重
    if (mappings.some((mapping) => mapping.to.toLowerCase() === target.toLowerCase())) {
      return { ok: false, error: `请求头映射的目标 ${target} 重复` };
    }
    mappings.push({ from: source, to: target });
  }
  return { ok: true, mappings };
}

// 存储为 JSON 字符串，读回逐项容错：脏数据里混入一项非法映射时其余仍生效
export function parseHeaderMappings(raw: unknown): HeaderMapping[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const mappings: HeaderMapping[] = [];
  for (const item of parsed) {
    if (mappings.length >= HEADER_MAPPING_MAX_ENTRIES) break;
    const result = validateHeaderMappings([item]);
    if (result.ok && result.mappings.length === 1 && !mappings.some((m) => m.to.toLowerCase() === result.mappings[0].to.toLowerCase())) {
      mappings.push(result.mappings[0]);
    }
  }
  return mappings;
}

export function stringifyHeaderMappings(mappings: HeaderMapping[]): string {
  return mappings.length === 0 ? "" : JSON.stringify(mappings);
}

// 映射只做改名、值恒取自客户端，因此每个调用点都是「覆盖同名键」。目标名的黑名单在保存
// 时已挡过一遍，这里再挡一次：手改库值或历史数据若带着鉴权头目标，客户端值就会被写进
// 鉴权头。名称同样要重新规范化并校验：运行期拿到的是未经校验的库值，直接拿去 get/set
// 会让 Headers 抛错，而这个异常落在 fetch 的 try 之外，会把整条转发路径变成永久 500
export function applyHeaderMappings(
  target: Headers,
  mappings: HeaderMapping[],
  inboundHeaders?: Headers,
): Headers {
  if (mappings.length === 0 || !inboundHeaders) return target;
  for (const mapping of mappings) {
    const fromName = normalizeCustomHeaderName(mapping.from);
    const toName = normalizeCustomHeaderName(mapping.to);
    if (!isValidHeaderName(fromName) || !isValidHeaderName(toName)) continue;
    if (BLOCKED_HEADERS.has(toName.toLowerCase())) continue;
    const value = inboundHeaders.get(fromName);
    if (!value || value.trim() === "") continue;
    target.set(toName, value);
  }
  return target;
}

type JsonRecord = Record<string, unknown>;

// 与 custom-headers 一致：条数上限防止单渠道配置异常放大每请求开销
export const REQUEST_BODY_OMIT_MAX_ENTRIES = 16;
export const REQUEST_BODY_OMIT_FIELD_NAME_MAX_LENGTH = 64;

// 只接受 ASCII 标识符形态的顶层字段名：既能覆盖上游协议的真实字段，
// 又能挡掉 "a.b"、"a[0]" 这类看似路径但实际不生效的写法，避免管理员误以为嵌套字段可剔除
export const REQUEST_BODY_OMIT_FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type RequestBodyOmitResult =
  | { ok: true; fields: string[] }
  | { ok: false; error: string };

// 承载请求语义的核心字段，删掉只会让上游收到无法处理的请求，不会带来任何兼容性收益。
// 与 custom-headers 的黑名单同理：允许剔除这些字段属于配置事故而非能力。
// contents 为 Gemini 风格字段，当前无对应出入口，作为前瞻性防御保留
const PROTECTED_FIELDS = new Set([
  "model",
  "messages",
  "input",
  "contents",
  "prompt",
  "system",
  "stream",
]);

export function validateRequestBodyOmit(value: unknown): RequestBodyOmitResult {
  if (value === undefined || value === null) return { ok: true, fields: [] };
  if (!Array.isArray(value)) return { ok: false, error: "剔除字段需为字符串数组。" };
  if (value.length > REQUEST_BODY_OMIT_MAX_ENTRIES) {
    return { ok: false, error: `剔除字段最多 ${REQUEST_BODY_OMIT_MAX_ENTRIES} 项。` };
  }

  const fields: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return { ok: false, error: "剔除字段需为字符串数组。" };
    const name = item.trim();
    if (name === "") continue;
    if (name.length > REQUEST_BODY_OMIT_FIELD_NAME_MAX_LENGTH) {
      return { ok: false, error: `字段名长度不能超过 ${REQUEST_BODY_OMIT_FIELD_NAME_MAX_LENGTH} 个字符。` };
    }
    if (!REQUEST_BODY_OMIT_FIELD_NAME_PATTERN.test(name)) {
      return { ok: false, error: `字段名 ${name} 非法，只支持顶层字段名。` };
    }
    if (PROTECTED_FIELDS.has(name)) {
      return { ok: false, error: `字段 ${name} 承载请求语义，不允许剔除。` };
    }
    if (!fields.includes(name)) fields.push(name);
  }
  return { ok: true, fields };
}

// 存储为 JSON 字符串，读回时容错：历史数据或手工改坏的值都不抛错，退化为「不剔除」
export function parseRequestBodyOmit(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const result = validateRequestBodyOmit(parsed);
  return result.ok ? result.fields : [];
}

export function stringifyRequestBodyOmit(fields: string[]): string {
  return fields.length === 0 ? "" : JSON.stringify(fields);
}

// 管理端表单按「每行一个字段名」编辑，此处负责与存储格式互转。
// 放这里而非组件内，便于测试往返无损且无需渲染 React
export function formatRequestBodyOmitInput(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return "";
    return parsed.filter((item): item is string => typeof item === "string").join("\n");
  } catch {
    return "";
  }
}

// 解析失败返回 null 由调用方拦下并提示，避免非法项往返一次后端才报错
export function parseRequestBodyOmitInput(value: string): string[] | null {
  const fields = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const validation = validateRequestBodyOmit(fields);
  return validation.ok ? validation.fields : null;
}

// 按渠道配置剔除顶层字段，返回新对象不原地修改：重试切换渠道后可按新配置重新计算。
// 只在字段确实存在时才拷贝，未配置或字段不存在时原样返回，避免给热路径增加无谓分配。
// 运行期再挡一次受保护字段：一旦出现受保护字段就整份不剔除，与 validateRequestBodyOmit
// 的「整份拒绝」语义保持一致，避免手改过的库值导致配置「悄悄生效一半」
export function omitRequestBodyFields<T extends JsonRecord>(body: T, fields: string[]): T {
  if (fields.length === 0) return body;
  if (fields.some((field) => PROTECTED_FIELDS.has(field))) return body;
  const present = fields.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (present.length === 0) return body;

  const next: JsonRecord = { ...body };
  for (const field of present) delete next[field];
  return next as T;
}

export const API_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

export type CappedBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too_large" | "read_failed" };

// 按硬上限分块读取请求体原始字节，超过上限返回 too_large（防止 content-length 被伪造导致内存放大）。
export async function readBodyCapped(request: Request, maxBytes: number): Promise<CappedBodyResult> {
  const body = request.body;
  if (!body) return { ok: true, bytes: new Uint8Array(0) };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "read_failed" };
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: merged };
}

export type CappedJsonBody = { ok: true; data: unknown } | { ok: false };

// 语义等同 request.json().catch(() => null)，额外施加请求体大小上限。
// 解析失败、空体与读流失败都返回 data: null，交由调用方的 schema 判定，避免改变既有错误码；
// 只有确认超过上限才返回 ok: false。
export async function readJsonBodyCapped(
  request: Request,
  maxBytes: number = API_BODY_LIMIT_BYTES,
): Promise<CappedJsonBody> {
  const result = await readBodyCapped(request, maxBytes);
  if (!result.ok) return result.reason === "too_large" ? { ok: false } : { ok: true, data: null };
  if (result.bytes.byteLength === 0) return { ok: true, data: null };
  try {
    return { ok: true, data: JSON.parse(new TextDecoder().decode(result.bytes)) };
  } catch {
    return { ok: true, data: null };
  }
}

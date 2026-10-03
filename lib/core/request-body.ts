export const API_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

// 按硬上限分块读取请求体原始字节，超过上限返回 null（防止 content-length 被伪造导致内存放大）。
export async function readBodyCapped(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const body = request.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export type CappedJsonBody = { ok: true; data: unknown } | { ok: false };

// 语义等同 request.json().catch(() => null)，额外施加请求体大小上限。
// 解析失败或空体返回 data: null，交由调用方的 schema 判定，避免改变既有错误码。
export async function readJsonBodyCapped(
  request: Request,
  maxBytes: number = API_BODY_LIMIT_BYTES,
): Promise<CappedJsonBody> {
  const bytes = await readBodyCapped(request, maxBytes);
  if (bytes === null) return { ok: false };
  if (bytes.byteLength === 0) return { ok: true, data: null };
  try {
    return { ok: true, data: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: true, data: null };
  }
}

export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";

const bodySchema = z.object({
  base_url: z.string().url(),
  api_key: z.string().min(1),
});

export async function POST(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const baseUrl = parsed.data.base_url.replace(/\/+$/, "");
  const apiKey = parsed.data.api_key;
  const url = `${baseUrl}/models`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return jsonError(`请求上游失败：${message}`, 502);
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    return jsonError(`上游返回 ${upstream.status}：${text.slice(0, 200) || "(无响应体)"}`, 502);
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    return jsonError("上游响应不是合法 JSON", 502);
  }

  const ids = extractModelIds(payload);
  if (ids.length === 0) return jsonError("未从上游解析到任何模型 ID", 502);

  return jsonOk({ data: ids });
}

function extractModelIds(payload: unknown): string[] {
  const candidates: unknown[] = [];
  if (Array.isArray(payload)) candidates.push(...payload);
  else if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.data)) candidates.push(...obj.data);
    else if (Array.isArray(obj.models)) candidates.push(...obj.models);
  }

  const ids = new Set<string>();
  for (const item of candidates) {
    if (typeof item === "string") {
      ids.add(item);
      continue;
    }
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const id = obj.id ?? obj.name ?? obj.model;
      if (typeof id === "string" && id.trim()) ids.add(id.trim());
    }
  }
  return [...ids].sort();
}

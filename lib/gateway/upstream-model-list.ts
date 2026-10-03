import { fetchUpstream } from "@/lib/gateway/upstream-proxy";
import { redactErrorMessage } from "@/lib/shared/redact";

const PROBE_TIMEOUT_MS = 15_000;

export type UpstreamModelListParams = {
  baseUrl: string;
  apiKey?: string | null;
  userAgent?: string | null;
  proxyUrl?: string | null;
};

export type UpstreamModelListResult =
  | { ok: true; ids: string[] }
  | { ok: false; message: string };

export function extractUpstreamModelIds(payload: unknown): string[] {
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

export async function fetchUpstreamModelIds(params: UpstreamModelListParams): Promise<UpstreamModelListResult> {
  const baseUrl = params.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = params.apiKey?.trim() ?? "";
  const userAgent = params.userAgent?.trim() ?? "";

  let upstream: Response;
  try {
    upstream = await fetchUpstream(
      `${baseUrl}/models`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "x-api-key": apiKey,
          Accept: "application/json",
          ...(userAgent ? { "User-Agent": userAgent } : {}),
        },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
      params.proxyUrl,
    );
  } catch (error) {
    return { ok: false, message: `请求上游失败：${redactErrorMessage(error)}` };
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    return { ok: false, message: `上游返回 ${upstream.status}：${text.slice(0, 200) || "(无响应体)"}` };
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, message: "上游响应不是合法 JSON" };
  }

  const ids = extractUpstreamModelIds(payload);
  if (ids.length === 0) return { ok: false, message: "未从上游解析到任何模型 ID" };

  return { ok: true, ids };
}

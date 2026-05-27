import type { GatewayProtocol } from "@/lib/gateway/protocols";

const RETRYABLE_UPSTREAM_STATUS = new Set([429, 500, 502, 503, 504]);

export function shouldRetryUpstreamStatus(status: number) {
  return RETRYABLE_UPSTREAM_STATUS.has(status);
}

export function parseUpstreamError(text: string, status: number) {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : null;
    const message =
      (typeof error?.message === "string" ? error.message : null)
      ?? (typeof parsed.message === "string" ? parsed.message : null)
      ?? text.trim()
      ?? `上游请求失败 (${status})`;
    const type =
      (typeof error?.type === "string" ? error.type : null)
      ?? (typeof parsed.type === "string" ? parsed.type : null)
      ?? "upstream_error";
    const code =
      (typeof error?.code === "string" || typeof error?.code === "number" ? error.code : null)
      ?? status;
    return { message, type, code };
  } catch {
    const message = text.trim() || `上游请求失败 (${status})`;
    return { message, type: "upstream_error", code: status };
  }
}

export function buildErrorResponseBody(message: string, status: number, inboundProtocol: GatewayProtocol, type?: string, code?: string | number) {
  if (inboundProtocol === "anthropic_messages") {
    return JSON.stringify({
      type: "error",
      error: {
        type: type ?? "api_error",
        message,
      },
    });
  }

  return JSON.stringify({
    error: {
      message,
      type: type ?? (status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error"),
      param: "None",
      code: String(code ?? status),
    },
  });
}

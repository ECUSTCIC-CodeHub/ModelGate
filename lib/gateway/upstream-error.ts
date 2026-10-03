import type { GatewayProtocol } from "@/lib/gateway/protocols";
import { redactUrlCredentials } from "@/lib/shared/redact";

const RETRYABLE_UPSTREAM_STATUS = new Set([401, 429, 500, 502, 503, 504]);

export function shouldRetryUpstreamStatus(status: number) {
  return RETRYABLE_UPSTREAM_STATUS.has(status);
}

// 计入熔断的上游状态：只有「渠道侧确实有问题」才算，业务 4xx（400/404/422 等）
// 是调用方请求本身的问题，多用户连续触发会把健康渠道误熔断。
// 4xx 里 401/403/429 反映凭据失效或被限流，仍属渠道侧问题，故保留
export function countsAsChannelFailure(status: number): boolean {
  if (status >= 500) return true;
  return status === 401 || status === 403 || status === 429;
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
    return { message: redactUrlCredentials(message), type, code };
  } catch {
    const message = text.trim() || `上游请求失败 (${status})`;
    return { message: redactUrlCredentials(message), type: "upstream_error", code: status };
  }
}

export function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  }
  return false;
}

export function upstreamFailureStatus(error: unknown): number {
  return isTimeoutError(error) ? 504 : 502;
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

import type { GatewayProtocol } from "@/lib/gateway/protocols";
import { redactUrlCredentials } from "@/lib/shared/redact";


// 上游返回哪些状态码时应当换下一个候选渠道。
// 判定完全基于状态码，不依赖响应报文内容：
// 关键词匹配无法同时满足「不误判调用方参数错误」与「不漏判真实额度文案」，
// 各上游文案形态无穷且中文没有词边界，因此改为由渠道配置显式声明。
const DEFAULT_RETRYABLE_STATUS: readonly number[] = [401, 402, 403, 429];

// 5xx 一律换渠道：那是上游自身故障，与调用方请求无关，不提供关闭途径。
function isServerError(status: number) {
  return status >= 500 && status <= 599;
}

export function isRetryableUpstreamStatus(status: number, retryStatusCodes?: readonly number[] | null) {
  if (isServerError(status)) return true;
  const configured = retryStatusCodes && retryStatusCodes.length > 0 ? retryStatusCodes : DEFAULT_RETRYABLE_STATUS;
  return configured.includes(status);
}

// 归一化用户填写的状态码列表：去重、升序、只保留合法 4xx/5xx。
export function normalizeRetryStatusCodes(input: unknown): number[] | null {
  if (input === null || input === undefined) return null;
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/[\s,，、]+/)
      : typeof input === "number"
        ? [input]
        : null;
  if (!raw) return null;
  const codes = new Set<number>();
  for (const item of raw) {
    const code = typeof item === "number" ? item : Number.parseInt(String(item).trim(), 10);
    if (!Number.isInteger(code) || code < 400 || code > 599) continue;
    codes.add(code);
  }
  return codes.size > 0 ? [...codes].sort((a, b) => a - b) : null;
}

export function shouldRetryUpstreamStatus(
  status: number,
  retryStatusCodes?: readonly number[] | null,
) {
  return isRetryableUpstreamStatus(status, retryStatusCodes);
}

// 计入熔断的上游状态：只有「渠道侧确实有问题」才算，业务 4xx（400/404/422 等）
// 是调用方请求本身的问题，多用户连续触发会把健康渠道误熔断。
// 判定同样只看状态码：5xx 恒计入，4xx 按配置（401/402/403/429 反映凭据失效、
// 计费欠费或被限流）。
export function countsAsChannelFailure(status: number, retryStatusCodes?: readonly number[] | null) {
  if (isServerError(status)) return true;
  if (status < 400) return false;
  const configured = retryStatusCodes && retryStatusCodes.length > 0 ? retryStatusCodes : DEFAULT_RETRYABLE_STATUS;
  return configured.includes(status);
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

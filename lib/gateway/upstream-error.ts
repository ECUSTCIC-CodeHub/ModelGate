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

// 严格解析单个状态码：只接受 400-599 的十进制整数。
// 不用 parseInt —— 它会把 "400abc"、"401e2"、"400.9" 静默截成 400/401，
// 让写错的值被当成合法配置，因此这里要求整串必须是纯数字。
function parseStatusCode(value: unknown): number | null {
  const text = typeof value === "string" ? value.trim() : String(value);
  if (!/^\d+$/.test(text)) return null;
  const code = Number(text);
  return code >= 400 && code <= 599 ? code : null;
}

// 归一化用户填写的状态码列表：去重、升序、只保留合法 4xx/5xx。
// 输入可以是数组，也可以是逗号/空白/中文顿号分隔的字符串。
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
    const code = parseStatusCode(item);
    if (code !== null) codes.add(code);
  }
  return codes.size > 0 ? [...codes].sort((a, b) => a - b) : null;
}

// 渠道列里存的是 JSON 数组文本；解析失败或为空按「未配置」处理，不让脏数据影响判定。
export function parseStoredRetryStatusCodes(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  try {
    return normalizeRetryStatusCodes(JSON.parse(raw));
  } catch {
    return null;
  }
}

// 生效的状态码列表：先取渠道级配置，未配置再回落全局默认，全局也没配置就用内置默认。
// 换渠道判定与熔断判定共用这一处解析，避免两边口径漂移。
export function resolveRetryStatusCodes(
  channelValue: string | null | undefined,
  globalDefault?: readonly number[] | null,
): readonly number[] {
  return parseStoredRetryStatusCodes(channelValue) ?? globalDefault ?? DEFAULT_RETRYABLE_STATUS;
}

// 落库形态：归一化后序列化为 JSON 文本；无有效值写 null（表示沿用全局默认）。
export function serializeRetryStatusCodes(input: unknown): string | null {
  const codes = normalizeRetryStatusCodes(input);
  return codes ? JSON.stringify(codes) : null;
}

// 5xx 恒为 true；4xx 只看生效的状态码列表是否包含它。
function matchesRetryStatus(status: number, retryStatusCodes?: readonly number[] | null) {
  if (isServerError(status)) return true;
  if (status < 400) return false;
  const configured = retryStatusCodes && retryStatusCodes.length > 0 ? retryStatusCodes : DEFAULT_RETRYABLE_STATUS;
  return configured.includes(status);
}

export function isRetryableUpstreamStatus(status: number, retryStatusCodes?: readonly number[] | null) {
  return matchesRetryStatus(status, retryStatusCodes);
}

// 是否换渠道（含 5xx 短路与配置回落），供路由与测试使用。
export const shouldRetryUpstreamStatus = isRetryableUpstreamStatus;

// 计入熔断的上游状态：只有「渠道侧确实有问题」才算，业务 4xx（400/404/422 等）
// 是调用方请求本身的问题，多用户连续触发会把健康渠道误熔断。
// 口径与换渠道判定完全一致，因此调用方必须传同一个生效列表，否则会出现
// 「配了 400 会换渠道、却不计熔断」的割裂。
export function countsAsChannelFailure(status: number, retryStatusCodes?: readonly number[] | null) {
  return matchesRetryStatus(status, retryStatusCodes);
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

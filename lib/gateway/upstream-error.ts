import type { GatewayProtocol } from "@/lib/gateway/protocols";
import { redactUrlCredentials } from "@/lib/shared/redact";

const RETRYABLE_UPSTREAM_STATUS = new Set([401, 429, 500, 502, 503, 504]);

// 上游以业务 4xx（多为 400）返回的「渠道自身余额/额度耗尽」文案。
// 这类报错虽然状态码是 4xx，成因却在渠道侧：换一个同别名渠道即可恢复，
// 因此要和调用方参数错误区分开，否则额度耗尽的渠道会被反复选中。
//
// 判定流程（见 isChannelCreditExhausted）：
//   1) 强特征或弱特征命中（两者都未命中则直接判否）；
//   2) 命中「请求参数校验类」特征即判否 —— 这一步对强特征同样生效；
//   3) 强特征放行；弱特征还需额度语境词佐证。
// 中文没有词边界，"额度已用尽" 会整串出现在 "unknown parameter: 额度已用尽告警开关"
// 这类参数名里，因此第 2 步是必需的，不能只靠把关键词写长。
//
// 强特征：语义自足，只可能出现在「渠道自身余额/额度耗尽」的报文里。
const STRONG_CREDIT_EXHAUSTED_PATTERNS = [
  "insufficient credit",
  "insufficient_quota",
  "insufficient quota",
  "insufficient balance",
  "insufficient_balance",
  "insufficient funds",
  "insufficient user quota",
  "insufficient account balance",
  "balance is insufficient",
  "balance is not enough",
  "not enough credit",
  "not enough balance",
  "no credits remaining",
  "no credit remaining",
  "credits exhausted",
  "credit exhausted",
  "quota has been exhausted",
  "quota exhausted",
  "quota is exhausted",
  "exhausted your quota",
  "exceeded your quota",
  "exceeded your current quota",
  "you exceeded your current quota",
  "credit balance is too low",
  "account is deactivated",
  "account has been deactivated",
  "payment required to",
  "账户余额不足",
  "账户余额为零",
  "账户余额为 0",
  "账户额度不足",
  "余额已不足",
  "额度已用尽",
  "额度已耗尽",
  "额度已用完",
  "配额已用尽",
  "配额已用完",
  "账户已欠费",
  "账户已停用",
  "检测到欠费",
];

// 请求参数校验类报文的特征：出现这些说明是「调用方传错了字段/取值」。
//
// 只收「明确指认调用方字段/取值有问题」的形态，不收 must be / expected / invalid / is required
// 这类任何报文都可能带的泛词——真实额度报文同样会带它们
// （"Your credit balance must be replenished"、"Insufficient credits: expected at least 1, got 0"），
// 一票否决会把渠道问题误判成参数错误，导致该换渠道时不换。
const REQUEST_VALIDATION_PATTERNS = [
  "unknown parameter",
  "unrecognized request argument",
  "unexpected keyword",
  "extra fields",
  "invalid value",
  "invalid type",
  "is not supported for this",
  // 额度词被当作参数名/字段名引用的常见形态
  "request quota exceeded",
  "字段填写错误",
  "字段类型",
  "参数为",
  "不是合法",
  "校验失败",
  "应为",
];

// 额度词被当作「参数名/字段名」引用的语法形态。
// 只认「额度/余额」类名词（不含单独的 credit，否则会把
// "insufficient credits: expected at least 1, got 0" 这种真实报文误判成参数校验）
// 紧跟字段语法（冒号/等号 + 校验动词）的写法。
const CREDIT_TERM_AS_IDENTIFIER_PATTERNS = [
  /(?:parameter|field|参数|字段)[^,，。;；]{0,24}[:：=][^,，。;；]{0,24}(?:额度|余额|欠费|quota|balance)/,
  /(?:额度|余额|欠费|quota|balance)[^,，。;；]{0,16}[:：=]\s*(?:must|should|expected|is |应为|不是)/,
];

// 纯机器码：上游把 error.code/type 原样回显（如 insufficient_quota、insufficient_credits）。
// 这类串本身就是额度耗尽的权威标记，不应被任何校验特征否决。
const CREDIT_CODE_PATTERN = /\binsufficient[_-](quota|credit|credits|balance|funds)\b|\binsufficient_quota\b/;

// 需要额外佐证时才判定的额度模式：这些词会作为参数名、字段名或取值范围出现，
// 因此要求「同时出现额度语境词」且「不含参数校验特征」。
const WEAK_CREDIT_EXHAUSTED_PATTERNS = [
  "current quota",
  "quota exceeded",
  "额度用尽",
  "额度耗尽",
  "额度用完",
  "额度不足",
  "余额不足",
  "欠费",
];

// 额度语境词：确认谈的是余额/额度本身，而不是别的领域的同名字段。
// 刻意不收与弱特征自身重合的词（余额/额度/欠费/账户），它们无法提供独立佐证。
const CREDIT_CONTEXT_PATTERNS = [
  "credit",
  "balance",
  "quota",
  "billing",
  "payment",
  "insufficient",
  "exhausted",
  "exceeded",
  "充值",
  "付费",
  "当前",
  "您的",
  "您的账",
];

// 需要词边界的强特征：单纯用 includes 会命中取值范围、未绑卡、RBAC 角色名等无关文案，
// 因此用正则限定后续词。
const STRONG_CREDIT_EXHAUSTED_PATTERNS_BOUNDARY = [
  // "out of credit(s)" 后面若是 range/limit/line/card，说明是取值范围或未绑卡
  /\bout of credits?\b(?!\s+(?:range|limit|line|card))/,
  /\bno credits?\b(?!\s+card)/,
  // "enough credit(s)" 也会出现在 "enough credit card information"、
  // "enough credit role"（RBAC）里，因此排除这些后续词。
  /\benough credits?\b(?!\s+(?:card|role|score|history|information))/,
];

export function isChannelCreditExhausted(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();

  // 纯机器码（insufficient_quota / insufficient_credits）是权威标记，不受其它特征影响。
  if (CREDIT_CODE_PATTERN.test(lower)) return true;

  // 额度词被当作参数名/字段名引用时，这是调用方的参数错误，不是渠道余额问题。
  const asIdentifier =
    REQUEST_VALIDATION_PATTERNS.some((pattern) => lower.includes(pattern)) ||
    CREDIT_TERM_AS_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(lower));
  if (asIdentifier) return false;

  // 强特征语义自足，命中即认定。
  const strong =
    STRONG_CREDIT_EXHAUSTED_PATTERNS.some((pattern) => lower.includes(pattern)) ||
    STRONG_CREDIT_EXHAUSTED_PATTERNS_BOUNDARY.some((pattern) => pattern.test(lower));
  if (strong) return true;

  // 弱特征会作为普通词汇出现，需要额度语境词佐证。
  const weak = WEAK_CREDIT_EXHAUSTED_PATTERNS.some((pattern) => lower.includes(pattern));
  if (!weak) return false;
  return CREDIT_CONTEXT_PATTERNS.some((context) => lower.includes(context));
}

// 402 Payment Required 是渠道侧计费问题（余额/额度不足），语义上没有其它含义，
// 因此直接按状态码认定，不依赖报文是否回显关键词。
const PAYMENT_REQUIRED_STATUS = 402;

export function shouldRetryUpstreamStatus(status: number, errorText?: string | null) {
  if (RETRYABLE_UPSTREAM_STATUS.has(status)) return true;
  if (status === PAYMENT_REQUIRED_STATUS) return true;
  // 渠道额度耗尽常被上游包成 4xx（400/402/403），需按响应文本兜住。
  return status >= 400 && status < 500 && isChannelCreditExhausted(errorText);
}

// 计入熔断的上游状态：只有「渠道侧确实有问题」才算，业务 4xx（400/404/422 等）
// 是调用方请求本身的问题，多用户连续触发会把健康渠道误熔断。
// 4xx 里 401/402/403/429 反映凭据失效、计费欠费或被限流，仍属渠道侧问题，故保留。
//
// errorText 用于识别「上游以 4xx 返回渠道额度耗尽」：不传时退化为纯状态码判断。
// 上游错误失败路径（gateway-handler.ts 的非流式/流式 4xx 分支、queued-upstream-response.ts）
// 目前都以 ok:false 无条件计失败，因此熔断照样生效；传 errorText 的场景是调用方
// 已拿到响应文本、希望按文本细分时。
export function countsAsChannelFailure(status: number, errorText?: string | null): boolean {
  if (status >= 500) return true;
  if (status === 401 || status === 403 || status === PAYMENT_REQUIRED_STATUS || status === 429) return true;
  // 渠道额度耗尽属渠道侧问题，应计入连续失败，避免一直被选中。
  return isChannelCreditExhausted(errorText);
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

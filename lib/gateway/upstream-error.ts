import type { GatewayProtocol } from "@/lib/gateway/protocols";
import { redactUrlCredentials } from "@/lib/shared/redact";

const RETRYABLE_UPSTREAM_STATUS = new Set([401, 429, 500, 502, 503, 504]);

// 上游以业务 4xx（多为 400）返回的「渠道自身余额/额度耗尽」文案。
// 这类报错虽然状态码是 4xx，成因却在渠道侧：换一个同别名渠道即可恢复，
// 因此要和调用方参数错误区分开，否则额度耗尽的渠道会被反复选中。
//
// 判定流程（见 isChannelCreditExhausted）：
//   1) 命中纯机器码（insufficient_quota / insufficient_user_quota）→ 认定；
//   2) 命中「参数校验」特征（字段指认词，或额度词被当作字段名的语法形态）→ 判否；
//   3) 强特征命中 → 认定；
//   4) 弱特征命中且另有额度语境词 → 认定。
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
  "not enough quota",
  "no credits remaining",
  "no credit remaining",
  "credits exhausted",
  "credit exhausted",
  "credits are exhausted",
  "quota has been exhausted",
  "quota exhausted",
  "quota is exhausted",
  "quota is running low",
  "exhausted your quota",
  "exceeded your quota",
  "exceeded your current quota",
  "you exceeded your current quota",
  "credit balance is too low",
  "credit limit reached",
  "reached your credit limit",
  "resource has been exhausted",
  "no remaining credits",
  "credits have been depleted",
  "credits depleted",
  "usage budget has been exceeded",
  "usage limit for this billing period",
  "requires billing to be enabled",
  "used all your free credits",
  "account is not active",
  "account is deactivated",
  "account has been deactivated",
  "payment required to",
  "账户余额不足",
  "账户余额为零",
  "账户余额为 0",
  "账户余额为0",
  "账户余额已耗尽",
  "账户额度不足",
  "余额已不足",
  "余额已耗尽",
  "额度已超限",
  "剩余额度不足",
  "可用额度不足",
  "用户额度不足",
  "预付费余额为 0",
  "预付费余额为0",
  "额度已用尽",
  "额度已耗尽",
  "额度已用完",
  "配额已用尽",
  "配额已用完",
  "账户已欠费",
  "账户已停用",
  "检测到欠费",
  // 语义自足的中文口语化形态：「欠费」「配额不足」「余额耗尽」本身就表达渠道侧欠费/额度耗尽，
  // 放在强特征里，避免依赖脆弱的「语境词」佐证（语境词表一改这类报文就整体漏判）。
  "欠费",
  "配额不足",
  "余额耗尽",
  "余额用完",
  "额度不够",
  "余额不够",
  "配额用完",
  "配额耗尽",
  // 「额度不足 / 余额不足」同样语义自足，且是最口语化的中文形态；
  // 配置项名（额度不足阈值/额度不足提醒开关）由校验特征与配置项正则挡掉。
  "额度不足",
  "余额不足",
  "配额用尽",
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
  "is not supported",
  "is not allowed",
  // 额度词被当作参数名/字段名引用的常见形态
  "request quota exceeded",
  "字段填写错误",
  "字段类型",
  "参数为",
  "不是合法",
  "校验失败",
  "应为",
  // 明确指认调用方字段/取值有问题的中文表述：
  // 额度词常被用作配置项名出现在这些句子里（如「额度已用尽告警开关 不可为空」），
  // 它们不会出现在真实的渠道额度报文里。
  "参数非法",
  "参数错误",
  "非法参数",
  "未知参数",
  "未知字段",
  "不合法",
  "无效取值",
  "缺少必填",
  "不可为空",
  "超出范围",
  "格式错误",
  "类型错误",
  "类型不匹配",
  "仅支持",
  "不支持",
  "长度超过",
  "参数校验",
];

// 额度词被当作「参数名/字段名」引用的语法形态。
// 只认「额度/余额」类名词（不含单独的 credit，否则会把
// "insufficient credits: expected at least 1, got 0" 这种真实报文误判成参数校验）
// 紧跟字段语法（冒号/等号 + 校验动词）的写法。
const CREDIT_TERM_AS_IDENTIFIER_PATTERNS = [
  /(?:parameter|field|参数|字段)[^,，。;；]{0,24}[:：=][^,，。;；]{0,24}(?:额度|余额|欠费|quota|balance)/,
  /(?:额度|余额|欠费|quota|balance)[^,，。;；]{0,16}[:：=]\s*(?:must|should|expected|is |应为|不是)/,
];

// 纯机器码：上游把 error.code/type 原样回显（insufficient_quota、insufficient_user_quota）。
// 这类串本身就是额度耗尽的权威标记，不应被任何校验特征否决。
// 中间允许再有下划线分段（one-api/new-api 的 insufficient_user_quota / insufficient_user_balance）。
const CREDIT_CODE_PATTERN =
  /insufficient[_-](?:[a-z0-9]+[_-])*(?:quota|credit|credits|balance|funds)\b/;

// 需要额外佐证时才判定的额度模式：这些词会作为参数名、字段名或取值范围出现，
// 因此要求「同时出现额度语境词」且「不含参数校验特征」。
// 弱特征：会作为普通词汇/参数名出现，需要额度语境词或陈述句形态佐证。
// 注意不要收录已在强特征表里的词（强特征分支先返回，弱特征副本是死代码）。
const WEAK_CREDIT_EXHAUSTED_PATTERNS = [
  "current quota",
  "quota exceeded",
  "额度用尽",
  "额度耗尽",
  "额度用完",
];

// 额度语境词：确认谈的是余额/额度本身，而不是别的领域的同名字段。
// 刻意不收与弱特征自身重合的词（余额/额度/欠费/账户），它们无法提供独立佐证；
// 也不收「当前」「您的」这类极高频词——它们会让任何含弱特征的报文都通过佐证，
// 例如「您的额度不足提醒开关为必填项」是配置项校验，不是渠道余额问题。
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
  // 陈述句里的额度主体，比「当前」「您的」更具体（见 WEAK_CREDIT_SENTENCE_PATTERNS）
  "您的账户",
  "您的余额",
  "账户余额",
  "账户额度",
];

// 弱特征出现在「配置项名」里时不是渠道余额问题，例如
// 「您的额度不足提醒开关为必填项」「未知参数: 额度不足阈值」「用户欠费率配置」。
// 这类写法里额度词后面紧跟名词性成分，而真实报文是「当前额度不足，无法完成请求」这样的句子。
const WEAK_CREDIT_AS_SETTING_PATTERNS = [
  /(?:额度|余额|欠费|配额)(?:不足|用尽|耗尽|用完|不够)?(?:提醒|通知|告警|阈值|配置|文案|开关|设置|参数|长度|上限|规则|策略|率|提示|说明|描述)/,
];

// 需要词边界的强特征：单纯用 includes 会命中取值范围、未绑卡、RBAC 角色名等无关文案，
// 因此用正则限定后续词。分隔符要放宽（逗号/句号/连字符等都可能出现在中间），
// 否则 "out of credit, expected 0-100" 这类取值范围文案会被误判成额度耗尽。
const STRONG_CREDIT_EXHAUSTED_PATTERNS_BOUNDARY = [
  /\bout of credits?\b(?![\s,，。;；:：!！\-—]*(?:range|limit|line|card|value|expected|expecting|应为|取值|范围))/,
  /\bno credits?\b(?![\s,，。;；:：!！\-—]*(?:card|for))/,
  /\benough credits?\b(?![\s,，。;；:：!！\-—]*(?:card|role|score|history|information|for))/,
];

// 弱特征以陈述句形式出现时的佐证：「当前额度不足，无法完成请求」「余额不足 请充值」。
// 要求额度词后是标点或明确的动词/祈使成分，而不是任意空白——
// 「当前额度不足 参数校验不通过」这种「额度词 + 空格 + 校验结论」仍是参数校验报文，
// 由 REQUEST_VALIDATION_PATTERNS（参数校验不通过/校验失败）挡掉。
const WEAK_CREDIT_SENTENCE_PATTERNS = [
  /(?:额度|余额|配额|欠费)(?:不足|用尽|耗尽|用完|不够)(?=[，。；、,;:：!！?？]|$|无法|不能|请|将|已|导致|因此)/,
];

export function isChannelCreditExhausted(text: string | null | undefined): boolean {
  if (!text) return false;
  // 归一化零宽字符与全角空格后再匹配：中转站 JSON 转义里偶有零宽字符，
  // 会让 "insufficient_credits" 这类本该命中的报文整串失配。
  // 只影响匹配，原文仍用于日志与错误透传。
  const lower = text.toLowerCase().replace(/[\u200b-\u200f\ufeff\u3000]/g, "");

  // 额度词被当作参数名/字段名引用时，这是调用方的参数错误，不是渠道余额问题。
  // 注意：这一步必须在机器码判定之前——"invalid value for field: ...insufficient credit history"
  // 里也含机器码词形，但它明确是在指认调用方字段。
  const asIdentifier =
    REQUEST_VALIDATION_PATTERNS.some((pattern) => lower.includes(pattern)) ||
    CREDIT_TERM_AS_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(lower)) ||
    WEAK_CREDIT_AS_SETTING_PATTERNS.some((pattern) => pattern.test(lower));
  if (asIdentifier) return false;

  // 纯机器码（insufficient_quota / insufficient_credits）是权威标记。
  // 归一化会去掉零宽字符与全角空格，可能把 "insufficient credits" 粘成
  // "insufficientcredits"，因此额外匹配紧凑形态；半角空格由 \s* 覆盖。
  if (
    CREDIT_CODE_PATTERN.test(lower) ||
    /\binsufficient\s*(?:quota|credit|credits|balance|funds)\b/.test(lower)
  ) {
    return true;
  }

  // 强特征语义自足，命中即认定。
  const strong =
    STRONG_CREDIT_EXHAUSTED_PATTERNS.some((pattern) => lower.includes(pattern)) ||
    STRONG_CREDIT_EXHAUSTED_PATTERNS_BOUNDARY.some((pattern) => pattern.test(lower));
  if (strong) return true;

  // 弱特征会作为普通词汇出现，需要额度语境词佐证。
  const weak = WEAK_CREDIT_EXHAUSTED_PATTERNS.some((pattern) => lower.includes(pattern));
  if (!weak) return false;
  if (CREDIT_CONTEXT_PATTERNS.some((context) => lower.includes(context))) return true;
  return WEAK_CREDIT_SENTENCE_PATTERNS.some((pattern) => pattern.test(text));
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
  // 限定 4xx：只有「请求失败」才谈得上连续失败，2xx/3xx 即使文本含额度词也不算。
  if (status < 400 || status >= 500) return false;
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

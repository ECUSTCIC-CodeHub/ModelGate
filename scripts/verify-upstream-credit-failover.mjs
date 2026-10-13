// 直接对真实实现做断言（不走 candidate-loop 的 loader，那个会把 upstream-error.ts
// 替换成占位实现，测不到真实分类逻辑）。
//
// upstream-error.ts 本身只依赖 @/lib/gateway/protocols（类型）与 @/lib/shared/redact，
// 因此用 alias-loader 只做 "@/" -> 仓库根 的解析、不 stub 任何模块。
//
// 运行：node --experimental-transform-types --loader ./scripts/alias-loader.mjs scripts/verify-upstream-credit-failover.mjs
//
// 判定分两档 + 参数校验排除，因此用例必须双向覆盖：
//   正例（真实额度耗尽文案，必须命中）/ 反例（参数校验、普通文案，必须不命中）。
// 三轮审计给出的所有误判面都固化在「反例」里，防止回归。
const { shouldRetryUpstreamStatus, countsAsChannelFailure, isChannelCreditExhausted } =
  await import("../lib/gateway/upstream-error.ts");

const USER_CASE =
  "You have insufficient credits to make this request. Please purchase more credits to continue using the service.";

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  if (actual === expected) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}: got ${actual}, want ${expected}`);
    fail++;
  }
};

console.log("=== 1. 用户实际报文：400 + insufficient credits 应换渠道并计熔断 ===");
check("400 + 用户报文 -> retry", shouldRetryUpstreamStatus(400, USER_CASE), true);
check("400 + 用户报文 -> countsAsChannelFailure", countsAsChannelFailure(400, USER_CASE), true);
check("isChannelCreditExhausted(用户报文)", isChannelCreditExhausted(USER_CASE), true);

console.log("\n=== 2. 原有可重试状态不受影响 ===");
for (const s of [401, 429, 500, 502, 503, 504]) {
  check(`status ${s} -> retry`, shouldRetryUpstreamStatus(s), true);
}
// 402 Payment Required 语义自足，按状态码认定，不依赖报文是否回显关键词
check("402 裸状态 -> retry", shouldRetryUpstreamStatus(402), true);
check("402 裸状态 -> countsAsChannelFailure", countsAsChannelFailure(402), true);

console.log("\n=== 3. 业务 4xx（调用方参数错误）不换渠道、不计熔断 ===");
const paramErrors = [
  ["temperature 越界", '{"error":{"message":"Invalid value for temperature: must be <= 2","type":"invalid_request_error"}}'],
  ["缺少 messages", '{"error":{"message":"messages: at least one message is required"}}'],
  ["未知参数", '{"error":{"message":"unknown parameter: foo"}}'],
  ["上下文超长", '{"error":{"message":"context length exceeded"}}'],
  ["model not found", '{"error":{"message":"model not found"}}'],
  ["不可处理的实体", '{"error":{"message":"unprocessable entity"}}'],
];
for (const [label, body] of paramErrors) {
  check(`不换渠道: ${label}`, shouldRetryUpstreamStatus(400, body), false);
  check(`不计熔断: ${label}`, countsAsChannelFailure(400, body), false);
}
check("400 无文本不换渠道", shouldRetryUpstreamStatus(400, null), false);
check("400 无文本不计熔断", countsAsChannelFailure(400, null), false);

console.log("\n=== 4. 真实渠道额度耗尽文案（必须命中） ===");
const creditBodies = [
  ["用户报文", USER_CASE],
  ["纯机器码 insufficient_quota", "insufficient_quota"],
  ["纯机器码 insufficient_credits", "insufficient_credits"],
  ["anthropic 标准", "Your credit balance is too low to access the API"],
  ["no credits remaining", "You have no credits remaining"],
  ["exceeded your quota", "You have exceeded your quota"],
  ["配额已用尽", "您的配额已用尽"],
  ["账户余额为零", "您的账户余额为零"],
  ["Credits exhausted", "Credits exhausted. Please top up."],
  ["quota exceeded", "quota exceeded"],
  ["检测到欠费", "系统检测到欠费"],
  ["out of credit", "You are out of credit"],
  ["out of credits", "You are out of credits"],
  ["Insufficient credits", "Insufficient credits"],
  ["账户余额为 0", "账户余额为 0，请充值"],
  ["额度已用完", "您的额度已用完，请充值"],
  ["openai current quota", "You exceeded your current quota, please check your plan and billing details."],
  ["账户余额不足", "账户余额不足"],
  ["额度已用尽", "额度已用尽"],
  ["账户已欠费", "该账户已欠费"],
  ["Payment required to", "Payment required to continue using the service"],
  ["balance is insufficient", "Your balance is insufficient"],
  ["balance is not enough", "Your balance is not enough to make this request"],
  ["余额已不足", "余额已不足"],
  ["当前额度不足", "当前额度不足，无法完成请求"],
  ["账户欠费请充值", "您的账户欠费，请及时充值"],
  ["Insufficient account balance", "Insufficient account balance"],
  ["not enough credits", "You do not have enough credits"],
];
for (const [label, body] of creditBodies) {
  check(`额度耗尽命中: ${label}`, isChannelCreditExhausted(body), true);
  check(`额度耗尽换渠道: ${label}`, shouldRetryUpstreamStatus(400, body), true);
  check(`额度耗尽计熔断: ${label}`, countsAsChannelFailure(400, body), true);
}

console.log("\n=== 5. 参数校验报文里的额度词不算渠道问题（三轮审计的误判面） ===");
const validationBodies = [
  // 额度词被当作参数名/字段名引用
  ["额度已用尽做参数名", "unknown parameter: 额度已用尽告警开关"],
  ["账户已停用做参数名", "unknown parameter: 账户已停用通知模板"],
  ["account is deactivated 做取值", "invalid value: account is deactivated is not allowed"],
  ["out of credits 做取值范围", "field out of credits range: expected 0-100"],
  ["out of credit range", "model out of credit range"],
  ["payment required to 做参数名", "unknown parameter: payment required to access premium model"],
  ["insufficient credit history 做字段说明", "invalid value for field: report users with insufficient credit history"],
  ["current quota 参数校验", "Invalid value for current quota: must be an integer"],
  ["current quota 不支持", "The current quota setting is not supported for this model"],
  ["额度用完做参数名", "unknown parameter: 额度用完阈值"],
  ["账户欠费做参数名", "unknown parameter: 账户欠费配置"],
  ["额度不足做参数名", "unknown parameter: 额度不足阈值"],
  ["余额不足做文案变量", "Invalid value for 余额不足提示文案"],
  ["欠费做参数名", "unknown parameter: 欠费率"],
  ["request quota exceeded", "The request quota exceeded the allowed maximum"],
  // 中文校验特征（中文没有词边界，必须能识别）
  ["中文参数非法", "参数非法：账户欠费 字段类型应为字符串"],
  ["中文参数错误", "参数错误: 额度不足 不是合法的日期格式"],
  ["中文字段填写错误", "quota 字段填写错误：当前额度不足"],
  // 同形词的其它含义
  ["no credit card on file", "no credit card on file"],
  ["enough credit card info", "Please make sure you have enough credit card information on file"],
  ["enough credit role (RBAC)", "You need enough credit role to access this resource"],
  ["billing_address 参数校验", "Invalid value for billing_address: must be a string"],
  ["temperature", "Invalid value for temperature: must be <= 2"],
  ["model not found", "model not found"],
];
for (const [label, body] of validationBodies) {
  check(`不误判: ${label}`, isChannelCreditExhausted(body), false);
  check(`不换渠道: ${label}`, shouldRetryUpstreamStatus(400, body), false);
}

console.log("\n=== 6. 弱特征在无校验特征时仍需额度语境佐证 ===");
check("弱特征+语境 -> 命中", isChannelCreditExhausted("quota exceeded"), true);
// 弱特征本身带额度词（quota/额度），因此单独出现即可自证；校验报文由第 5 组挡掉
check("弱特征自带额度语境 -> 命中", isChannelCreditExhausted("current quota"), true);
check("中文弱特征+当前 -> 命中", isChannelCreditExhausted("当前额度不足"), true);
check("无任何额度特征 -> 不命中", isChannelCreditExhausted("something went wrong"), false);

console.log("\n=== 7. countsAsChannelFailure 原有语义不变 ===");
check("5xx 计熔断", countsAsChannelFailure(500), true);
check("502 计熔断", countsAsChannelFailure(502), true);
check("401 计熔断", countsAsChannelFailure(401), true);
check("403 计熔断（原有语义）", countsAsChannelFailure(403, '{"error":{"message":"forbidden"}}'), true);
check("429 计熔断", countsAsChannelFailure(429), true);
check("404 不计熔断", countsAsChannelFailure(404), false);
check("403 不换渠道（原有语义）", shouldRetryUpstreamStatus(403, '{"error":{"message":"forbidden"}}'), false);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);

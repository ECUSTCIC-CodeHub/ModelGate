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
  // 真实报文里也可能带 "expected"/"must be" 这类泛词，不能被校验排除误伤
  ["insufficient credits + expected", "insufficient credits: expected at least 1, got 0"],
  ["out of credit limit 之外的 out of credit", "You are out of credits"],
  // 真实上游机器码（one-api / new-api 的 insufficient_user_quota）
  ["机器码 insufficient_user_quota", "insufficient_user_quota"],
  ["机器码 insufficient_user_balance", "insufficient_user_balance"],
  // 语义自足的常见中文形态
  ["账户余额为0", "账户余额为0"],
  ["余额已耗尽", "余额已耗尽"],
  ["剩余额度不足", "剩余额度不足"],
  ["可用额度不足", "可用额度不足"],
  ["额度已超限", "额度已超限"],
  ["用户额度不足(new-api)", "用户额度不足, 剩余额度: 0"],
  ["当前额度不足陈述句", "当前额度不足，无法完成请求"],
  // 真实上游英文形态
  ["credits are exhausted", "Your credits are exhausted"],
  ["quota is running low", "Your quota is running low"],
  ["gemini resource exhausted", "Resource has been exhausted (e.g. check quota)."],
  // 语义自足的中文口语化形态（提升为强特征，不再依赖脆弱的语境词佐证）
  ["裸 欠费", "欠费"],
  ["该账号已欠费", "该账号已欠费"],
  ["渠道欠费停用", "渠道欠费停用"],
  ["裸 配额不足", "配额不足"],
  ["裸 余额耗尽", "余额耗尽"],
  ["额度不足陈述句", "额度不足，无法完成请求"],
  ["额度不足 已停用", "额度不足 已停用"],
  ["额度不足 不能继续", "额度不足 不能继续"],
  ["裸 余额不足", "余额不足"],
  // 零宽 / 全角空白需归一化后再匹配（中转站 JSON 转义偶有零宽字符）
  ["零宽 insufficient credits", "insufficient\u200bcredits"],
  ["零宽 额度不足", "额度\u200b不足"],
  ["零宽 欠费", "欠\u200b费"],
  ["全角空格 insufficient credits", "insufficient\u3000credits"],
  // 其它真实上游计费文案
  ["no remaining credits", "no remaining credits"],
  ["credits have been depleted", "Your credits have been depleted"],
  ["usage budget exceeded", "Your usage budget has been exceeded"],
  ["requires billing enabled", "This API method requires billing to be enabled"],
  ["预付费余额为 0", "预付费余额为 0，无法调用"],
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
  // 额度词做字段名 + 校验动词
  ["field quota must be positive", "field quota: must be positive"],
  ["parameter balance expected", "parameter balance: expected number"],
  // 语境词 当前/您的 很泛，不能单独构成额度证据
  ["当前模型不支持该参数", "当前模型不支持该参数"],
  ["您的请求已受理", "您的请求已受理"],
  ["当前并发已满", "当前并发已满，请稍后重试"],
  ["您的输入过长", "您的输入过长，请缩短"],
  // 额度词被当作配置项名 + 校验结论（第四轮审计的中文回归面）
  ["配置项 不可为空", "额度已用尽告警开关 不可为空"],
  ["配置项 超出范围", "额度已用尽阈值 超出范围"],
  ["配置项 格式错误", "账户余额不足配置 格式错误"],
  ["取值 无效取值", "账户余额不足 无效取值"],
  ["配置 不支持", "当前额度不足 不支持该配置"],
  ["缺少必填字段", "账户余额不足 缺少必填字段"],
  ["未知字段", "额度已用尽 未知字段"],
  ["类型不匹配", "额度已用尽 类型不匹配"],
  ["非法参数", "额度已用尽 非法参数"],
  ["长度超过", "账户余额不足 长度超过 64"],
  ["方括号参数名", "请求参数 [账户余额不足] 类型错误"],
  ["弱特征+校验语义", "当前额度不足 参数校验不通过，请检查请求"],
  ["弱特征+配置项名", "您的额度不足提醒开关为必填项"],
  ["弱特征+文案长度", "当前欠费提醒文案长度超限"],
  // out of credit 后置否定的分隔符放宽后仍要挡住
  ["out of credit, expected", "the value is out of credit, expected 0-100"],
  ["out of credit! range", "out of credit! range check failed"],
  ["out of credit。取值范围", "该值 out of credit。取值范围 0-100"],
  // 语义自足的中文词提升为强特征后，配置项名/参数名校验仍要挡住
  ["欠费率配置", "用户欠费率配置"],
  ["欠费提醒开关", "欠费提醒开关 不可为空"],
  ["欠费金额字段", "欠费金额: must be positive"],
  ["配额不足阈值", "配额不足阈值"],
  ["余额耗尽提醒文案", "余额耗尽提醒文案"],
  ["额度不足+参数校验", "额度不足 参数校验不通过，请检查请求"],
  // 配置项名后缀扩展到 提示/说明/描述
  ["余额不足提示", "余额不足提示"],
  ["额度不足说明", "额度不足说明"],
  ["欠费描述", "欠费描述"],
  // "insufficient credit" 后跟 score/rating/history/card/role/limit 时与渠道余额无关
  ["insufficient credit score", "insufficient credit score"],
  ["insufficient credit rating", "insufficient credit rating"],
  ["insufficient credit history 无校验词", "insufficient credit history for this model"],
  ["insufficient credit card information", "insufficient credit card information"],
  ["insufficient credit role", "insufficient credit role for access"],
  ["insufficient credit limit configured", "insufficient credit limit configured"],
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

// 验证上游换渠道判定：完全基于状态码，可由模型/渠道/全局配置覆盖。
// 运行：node --experimental-transform-types --loader ./scripts/alias-loader.mjs scripts/verify-upstream-retry-status.mjs
import {
  countsAsChannelFailure,
  isRetryableUpstreamStatus,
  normalizeRetryStatusCodes,
  parseStoredRetryStatusCodes,
  resolveRetryStatusCodes,
  serializeRetryStatusCodes,
  shouldRetryUpstreamStatus,
} from "../lib/gateway/upstream-error.ts";

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    passed += 1;
    return;
  }
  failed += 1;
  console.log(`  FAIL  ${label}: got ${actual}, want ${expected}`);
}

function checkJson(label, actual, expected) {
  check(label, JSON.stringify(actual), JSON.stringify(expected));
}

console.log("=== 1. 内置默认：401/402/403/429 与全部 5xx 换渠道 ===");
for (const status of [401, 402, 403, 429, 500, 502, 503, 504, 599]) {
  check(`默认 ${status} 换渠道`, shouldRetryUpstreamStatus(status), true);
}
for (const status of [200, 201, 204, 400, 404, 409, 422, 499]) {
  check(`默认 ${status} 不换渠道`, shouldRetryUpstreamStatus(status), false);
}

console.log("=== 2. 默认不换渠道里不再依赖报文内容 ===");
// 额度耗尽的 400 现在只有显式配置才换渠道；文本不再参与任何判定。
const credit400 = "You have insufficient credits to make this request.";
check("默认 400 + 额度报文 不换渠道", shouldRetryUpstreamStatus(400), false);
check("默认 400 + 额度报文 不计熔断", countsAsChannelFailure(400), false);
// 第二个入参是状态码列表，传报文不会改变结果
check("400 传报文不改变结果", shouldRetryUpstreamStatus(400, credit400), false);

console.log("=== 3. 渠道级配置覆盖默认 ===");
check("渠道配置含 400 时换渠道", shouldRetryUpstreamStatus(400, [400]), true);
check("渠道配置含 400 时计熔断", countsAsChannelFailure(400, [400]), true);
check("渠道配置含 400 时 404 不换", shouldRetryUpstreamStatus(404, [400]), false);
check("渠道配置含 400 时 500 仍换", shouldRetryUpstreamStatus(500, [400]), true);
check("渠道配置 [500] 时 401 不换", shouldRetryUpstreamStatus(401, [500]), false);
check("渠道配置 [500] 时 500 换", shouldRetryUpstreamStatus(500, [500]), true);
check("渠道配置 [404] 时 404 换", shouldRetryUpstreamStatus(404, [404]), true);
check("渠道配置 [429] 时 429 换", shouldRetryUpstreamStatus(429, [429]), true);

console.log("=== 4. 空/缺省配置回落内置默认 ===");
for (const value of [null, undefined]) {
  check(`${String(value)} 回落默认 401`, shouldRetryUpstreamStatus(401, value), true);
  check(`${String(value)} 回落默认 400`, shouldRetryUpstreamStatus(400, value), false);
  check(`${String(value)} 回落默认 500`, shouldRetryUpstreamStatus(500, value), true);
}
check("空数组回落默认 401", shouldRetryUpstreamStatus(401, []), true);
check("空数组回落默认 400", shouldRetryUpstreamStatus(400, []), false);

console.log("=== 5. isRetryableUpstreamStatus 与 shouldRetryUpstreamStatus 一致 ===");
for (const status of [200, 400, 401, 402, 403, 404, 429, 500, 502, 599]) {
  check(
    `一致 ${status}`,
    isRetryableUpstreamStatus(status, null),
    shouldRetryUpstreamStatus(status, null),
  );
  check(
    `一致(定制) ${status}`,
    isRetryableUpstreamStatus(status, [400, 418]),
    shouldRetryUpstreamStatus(status, [400, 418]),
  );
}

console.log("=== 6. countsAsChannelFailure：5xx 恒真，4xx 按配置 ===");
for (const status of [500, 502, 503, 504, 599]) {
  check(`熔断 ${status}`, countsAsChannelFailure(status), true);
  check(`熔断 ${status}(定制含400)`, countsAsChannelFailure(status, [400]), true);
}
for (const status of [400, 404, 409, 422]) {
  check(`不计熔断 ${status}`, countsAsChannelFailure(status), false);
}
check("计熔断 400(配置 400)", countsAsChannelFailure(400, [400]), true);
check("不计熔断 404(配置只含 400)", countsAsChannelFailure(404, [400]), false);
check("计熔断 401(默认)", countsAsChannelFailure(401), true);
check("计熔断 403(默认)", countsAsChannelFailure(403), true);
check("计熔断 429(默认)", countsAsChannelFailure(429), true);
// 2xx/3xx 永不因状态码计熔断，即便配置里误填了这些值
for (const status of [200, 201, 204, 301, 302]) {
  check(`不熔断 ${status}`, countsAsChannelFailure(status), false);
  check(`不熔断 ${status}(配置含 200)`, countsAsChannelFailure(status, [200, 400]), false);
}

console.log("=== 7. normalizeRetryStatusCodes 归一化 ===");
checkJson("数组去重升序", normalizeRetryStatusCodes([429, 401, 429, 402]), [401, 402, 429]);
checkJson("null 保持 null", normalizeRetryStatusCodes(null), null);
checkJson("undefined 保持 null", normalizeRetryStatusCodes(undefined), null);
checkJson("空数组返回 null", normalizeRetryStatusCodes([]), null);
checkJson("过滤 4xx 以下", normalizeRetryStatusCodes([200, 302, 400]), [400]);
checkJson("过滤 5xx 以上", normalizeRetryStatusCodes([600, 700, 500]), [500]);
checkJson("两边边界都保留", normalizeRetryStatusCodes([400, 599]), [400, 599]);
checkJson("过滤非整数", normalizeRetryStatusCodes([400.5, 401]), [401]);
checkJson("过滤非法值", normalizeRetryStatusCodes(["abc", 401, null, {}]), [401]);
checkJson("字符串逗号分隔", normalizeRetryStatusCodes("401,402,429"), [401, 402, 429]);
checkJson("字符串空白分隔", normalizeRetryStatusCodes("401 402  429"), [401, 402, 429]);
checkJson("中文字符分隔", normalizeRetryStatusCodes("401，402、429"), [401, 402, 429]);
checkJson("单个数字", normalizeRetryStatusCodes(400), [400]);
checkJson("全部非法返回 null", normalizeRetryStatusCodes(["abc", 200, 600]), null);

console.log("=== 8. 归一化结果可直接喂给判定 ===");
const normalized = normalizeRetryStatusCodes("400, 402");
checkJson("归一化输出", normalized, [400, 402]);
check("用归一化结果判 400", shouldRetryUpstreamStatus(400, normalized), true);
check("用归一化结果判 402", shouldRetryUpstreamStatus(402, normalized), true);
check("用归一化结果判 429", shouldRetryUpstreamStatus(429, normalized), false);


console.log("=== 9. 严格解析：写错的值不得被静默当成合法状态码 ===");
// parseInt 会把 "400abc" 截成 400，让拼错的值被当成合法配置；这里要求整串必须是纯数字
for (const bad of ["400abc", "401e2", "400.9", "40O", "0x190", "４０１"]) {
  checkJson(`拒绝 ${JSON.stringify(bad)}`, normalizeRetryStatusCodes(bad), null);
}
checkJson("混入脏值的列表只留合法项", normalizeRetryStatusCodes("400abc,500"), [500]);
checkJson("数组里的脏值同样被拒绝", normalizeRetryStatusCodes([400, "401x"]), [400]);
checkJson("合法值仍正常", normalizeRetryStatusCodes("401, 429"), [401, 429]);

console.log("=== 10. 换渠道与熔断口径必须一致（同一份生效列表）===");
for (const status of [400, 401, 402, 403, 404, 429, 500, 503]) {
  for (const codes of [null, [], [400], [401, 404], [500]]) {
    check(
      `口径一致 ${status} / ${JSON.stringify(codes)}`,
      shouldRetryUpstreamStatus(status, codes) === countsAsChannelFailure(status, codes),
      true,
    );
  }
}

console.log("=== 11. 渠道落库文本解析 ===");
checkJson("JSON 数组文本", parseStoredRetryStatusCodes("[400,429]"), [400, 429]);
checkJson("空串按未配置", parseStoredRetryStatusCodes(""), null);
checkJson("null 按未配置", parseStoredRetryStatusCodes(null), null);
checkJson("脏 JSON 按未配置", parseStoredRetryStatusCodes("{oops"), null);
checkJson("非数组 JSON 按未配置", parseStoredRetryStatusCodes('{"a":1}'), null);
checkJson("全非法数组按未配置", parseStoredRetryStatusCodes("[200,600]"), null);

console.log("=== 12. 生效列表优先级：模型 > 渠道 > 全局 > 内置默认 ===");
// 参数顺序：模型级、渠道级、全局默认
checkJson("模型优先于渠道与全局", resolveRetryStatusCodes("[400]", "[418]", [429]), [400]);
checkJson("模型未配置回落渠道", resolveRetryStatusCodes(null, "[418]", [400]), [418]);
checkJson("模型脏数据回落渠道", resolveRetryStatusCodes("{oops", "[418]", [400]), [418]);
checkJson("模型空串回落渠道", resolveRetryStatusCodes("", "[418]", [400]), [418]);
checkJson("模型与渠道都脏回落全局", resolveRetryStatusCodes("{oops", "{oops", [400]), [400]);
checkJson("渠道优先于全局", resolveRetryStatusCodes(null, "[418]", [400]), [418]);
checkJson("渠道未配置回落全局", resolveRetryStatusCodes(null, null, [400]), [400]);
checkJson("渠道脏数据回落全局", resolveRetryStatusCodes(null, "{oops", [400]), [400]);
checkJson("三者都没有用内置默认", resolveRetryStatusCodes(null, null, null), [401, 402, 403, 429]);
checkJson("空串渠道回落全局", resolveRetryStatusCodes(null, "", [429]), [429]);
// 空数组与未配置同义，绝不能返回空列表让下游误判成「一律不换渠道」
checkJson("空数组全局回落内置默认", resolveRetryStatusCodes(null, null, []), [401, 402, 403, 429]);
checkJson("空数组模型回落渠道", resolveRetryStatusCodes("[]", "[418]", [400]), [418]);
checkJson("全局 undefined 回落内置默认", resolveRetryStatusCodes(null, null, undefined), [401, 402, 403, 429]);
check("解析结果永不为空", resolveRetryStatusCodes(null, null, []).length > 0, true);

console.log("=== 13. 落库序列化 ===");
check("有值序列化", serializeRetryStatusCodes([429, 401, 429]), "[401,429]");
check("空值写 null", serializeRetryStatusCodes([]), null);
check("非法值写 null", serializeRetryStatusCodes("abc"), null);
check("null 写 null", serializeRetryStatusCodes(null), null);
checkJson("落库文本可被读回", parseStoredRetryStatusCodes(serializeRetryStatusCodes([400, 429])), [400, 429]);

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);

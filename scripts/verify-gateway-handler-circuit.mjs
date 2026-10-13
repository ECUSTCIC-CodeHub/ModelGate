// 运行时覆盖：真的执行到 lib/gateway/gateway-handler.ts 的熔断计入点。
//
// 存在理由：gateway-handler 的 4 个熔断计入点此前只有源码形态守卫（AST）。形态守卫
// 只能匹配「有穷的写法」，挡不住「调用点文本完全不变、只在判定前把
// route.model.retry_status_codes 写回」这种写入式变异 —— 无对象构造、无改名，
// 模型级配置被静默摘掉。本用例通过 loader 桩掉数据库/网络/鉴权，把
// handleGatewayProtocolRequest 跑到 4xx 熔断计入那一刻，断言计入结果确实由
// 路由自身的模型级配置决定；一旦某处写回把它清掉，运行时会立刻看见行为改变。
//
// 运行：
//   node --experimental-transform-types \
//     --loader ./scripts/verify-gateway-handler-circuit-loader.mjs \
//     scripts/verify-gateway-handler-circuit.mjs
import { handleGatewayProtocolRequest } from "@/lib/gateway/gateway-handler";
import { chatCompletionsGatewayAdapter } from "@/lib/gateway/protocol-adapters/chat-completions";

let passed = 0;
let failed = 0;

const show = (value) => (value === undefined ? "undefined" : JSON.stringify(value));

// 用 Object.is 直接比较原始值，避免 JSON.stringify 在 undefined/NaN 上的坑
// （JSON.stringify(undefined) 返回 undefined 而非字符串，undefined === undefined
// 会让期望与实测都为 undefined 的用例静默通过）。
function check(label, actual, expected) {
  if (Object.is(actual, expected)) {
    passed += 1;
    return;
  }
  failed += 1;
  console.log(`  FAIL  ${label}: got ${show(actual)}, want ${show(expected)}`);
}

const CREDIT_BODY = JSON.stringify({ error: { message: "insufficient credits" } });

function makeRoute({ channelId, modelRetryStatusCodes = null, channelRetryStatusCodes = null }) {
  return {
    channel: {
      id: channelId,
      name: `channel-${channelId}`,
      base_url: "https://upstream.invalid",
      max_concurrency: 0,
      retry_status_codes: channelRetryStatusCodes,
    },
    model: {
      id: 101,
      alias: "target",
      real_model: "real-target",
      quota_mode: "none",
      max_concurrency: 0,
      token_multiplier: 1,
      request_multiplier: 1,
      retry_status_codes: modelRetryStatusCodes,
    },
    effective_upstream_protocol: "chat_completions",
  };
}

function makeUser() {
  return {
    id: 1,
    username: "harness",
    role: "admin",
    group_id: null,
    allowed_model_aliases: null,
    rpm: -1,
    qps: -1,
    tpm: -1,
    enabled: 1,
    pref_model_fallback: "inherit",
    pref_vision_fallback: "inherit",
    pref_quota_fallback: "inherit",
  };
}

function makeSettings({ globalCodes = null, sameChannelRetry = 0 } = {}) {
  return {
    upstream_retry_enabled: 0,
    upstream_retry_max_attempts: 1,
    upstream_retry_same_channel: sameChannelRetry,
    upstream_retry_status_codes: globalCodes,
    ua_restrictions: null,
    model_fallback_enabled: 0,
    model_fallback_alias: null,
    vision_fallback_enabled: 0,
    vision_fallback_alias: null,
    quota_fallback_enabled: 0,
    quota_fallback_alias: null,
    runtime_features: { redeemCode: false },
  };
}

function installHarness({ routes, settings, upstreamStatus }) {
  const leaseOutcomes = [];
  const chatLogs = [];
  const attempted = [];
  globalThis.__HARNESS__ = {
    routes,
    settings,
    leaseOutcomes,
    chatLogs,
    attempted,
    allowedChannelIds: null,
    authResult: { ok: true, context: { user: makeUser(), key: { id: 9, key: "sk-harness" } } },
    fetchImpl: (route) => {
      attempted.push(route.channel.id);
      return new Response(CREDIT_BODY, { status: upstreamStatus, headers: { "content-type": "application/json" } });
    },
  };
  return { leaseOutcomes, chatLogs, attempted };
}

async function drive(harness, { stream = false } = {}) {
  const request = new Request("https://gateway.invalid/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "target", messages: [{ role: "user", content: "hi" }], stream }),
  });
  const response = await handleGatewayProtocolRequest(request, chatCompletionsGatewayAdapter);
  return { response, ...harness };
}

// A) 模型级配 400：4xx 计入点必须算「渠道失败」（ok=false 才代表计入熔断失败）
{
  const h = installHarness({ routes: [makeRoute({ channelId: 7, modelRetryStatusCodes: JSON.stringify([400]) })], settings: makeSettings(), upstreamStatus: 400 });
  const { response, leaseOutcomes } = await drive(h);
  check("模型级配 400：上游 400 透传", response.status, 400);
  check("模型级配 400：恰好一次熔断计入", leaseOutcomes.length, 1);
  check("模型级配 400：计为渠道失败", leaseOutcomes[0]?.ok, false);
}

// B) 模型级未配置、渠道级未配置、全局未配置：400 不计熔断（业务 4xx 不该误熔断）
{
  const h = installHarness({ routes: [makeRoute({ channelId: 7 })], settings: makeSettings(), upstreamStatus: 400 });
  const { leaseOutcomes } = await drive(h);
  check("未配置 400：不计渠道失败", leaseOutcomes[0]?.ok, true);
}

// C) 渠道级配 400：模型级未配置时回落渠道级，仍应计入
{
  const h = installHarness({ routes: [makeRoute({ channelId: 7, channelRetryStatusCodes: JSON.stringify([400]) })], settings: makeSettings(), upstreamStatus: 400 });
  const { leaseOutcomes } = await drive(h);
  check("渠道级配 400：计为渠道失败", leaseOutcomes[0]?.ok, false);
}

// D) 模型级压过渠道级：模型级未配 400、渠道级配 400 → 模型级空表示回落渠道级，
//    这里反向验证：模型级配 418、渠道级配 400，则 400 不该计熔断
{
  const h = installHarness({
    routes: [makeRoute({ channelId: 7, modelRetryStatusCodes: JSON.stringify([418]), channelRetryStatusCodes: JSON.stringify([400]) })],
    settings: makeSettings(),
    upstreamStatus: 400,
  });
  const { leaseOutcomes } = await drive(h);
  check("模型级配 418 压过渠道级 400：400 不计熔断", leaseOutcomes[0]?.ok, true);
}

// E) 全局默认配 400 + 模型/渠道均未配置：应计入
{
  const h = installHarness({ routes: [makeRoute({ channelId: 7 })], settings: makeSettings({ globalCodes: "400" }), upstreamStatus: 400 });
  const { leaseOutcomes } = await drive(h);
  check("全局默认配 400：计为渠道失败", leaseOutcomes[0]?.ok, false);
}

// F) 5xx 恒计熔断
{
  const h = installHarness({ routes: [makeRoute({ channelId: 7 })], settings: makeSettings(), upstreamStatus: 503 });
  const { leaseOutcomes } = await drive(h);
  check("5xx 恒计渠道失败", leaseOutcomes[0]?.ok, false);
}

// G) 流式分支的 4xx 计入点同样必须认模型级配置。
//    gateway-handler 有 3 个熔断计入点只在 stream 分支可达，非流式用例覆盖不到，
//    写入式变异藏在流式分支时会被漏掉，所以这里单独驱动 stream=true。
{
  const h = installHarness({ routes: [makeRoute({ channelId: 7, modelRetryStatusCodes: JSON.stringify([400]) })], settings: makeSettings(), upstreamStatus: 400, stream: true });
  const { response, leaseOutcomes } = await drive(h, { stream: true });
  check("流式分支：模型级配 400 时上游 400 透传", response.status, 400);
  check("流式分支：恰好一次熔断计入", leaseOutcomes.length, 1);
  check("流式分支：模型级配 400 计为渠道失败", leaseOutcomes[0]?.ok, false);
}
{
  const h = installHarness({ routes: [makeRoute({ channelId: 7 })], settings: makeSettings(), upstreamStatus: 400, stream: true });
  const { leaseOutcomes } = await drive(h, { stream: true });
  check("流式分支：未配置 400 不计渠道失败", leaseOutcomes[0]?.ok, true);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);

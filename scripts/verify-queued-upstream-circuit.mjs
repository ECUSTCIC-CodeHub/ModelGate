// 运行时覆盖：真的执行到 lib/gateway/queued-upstream-response.ts 的 3 个熔断计入点。
//
// 与 verify-gateway-handler-circuit.mjs 同一动机：AST 形态守卫挡不住「调用点文本不变、
// 只在判定前写回 route.model.retry_status_codes」的写入式变异。这里直接把
// createQueuedUpstreamResponse 跑到 4xx 计入那一刻，断言计入结果由路由自身的模型级
// 配置决定；任何写回都会让运行时断言立刻失败。
//
// 运行：
//   node --experimental-transform-types \
//     --loader ./scripts/verify-gateway-handler-circuit-loader.mjs \
//     scripts/verify-queued-upstream-circuit.mjs
import { createQueuedUpstreamResponse } from "@/lib/gateway/queued-upstream-response";
import { createChannelFailureJudge } from "@/lib/gateway/upstream-error";

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1;
    return;
  }
  failed += 1;
  console.log(`  FAIL  ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const CREDIT_BODY = JSON.stringify({ error: { message: "insufficient credits" } });

function makeRoute({ modelRetryStatusCodes = null, channelRetryStatusCodes = null } = {}) {
  return {
    channel: { id: 7, name: "channel-7", base_url: "https://upstream.invalid", max_concurrency: 0, retry_status_codes: channelRetryStatusCodes },
    model: { id: 101, alias: "target", real_model: "real-target", quota_mode: "none", max_concurrency: 0, retry_status_codes: modelRetryStatusCodes },
    effective_upstream_protocol: "chat_completions",
  };
}

function makeUser() {
  return { id: 1, username: "harness", role: "admin", group_id: null, allowed_model_aliases: null, rpm: -1, qps: -1, tpm: -1, enabled: 1 };
}

// 驱动一次到上游 4xx：返回 lease 的 complete 结果与最终响应。
async function drive({ route, upstreamStatus = 400, stream = true }) {
  const leaseOutcomes = [];
  globalThis.__HARNESS__ = {
    routes: [route],
    settings: { runtime_features: { redeemCode: false } },
    leaseOutcomes,
    chatLogs: [],
    allowedChannelIds: null,
    authResult: { ok: true, context: { user: makeUser(), key: { id: 9, key: "sk-harness" } } },
    fetchImpl: () => new Response(CREDIT_BODY, { status: upstreamStatus, headers: { "content-type": "application/json" } }),
  };

  const response = createQueuedUpstreamResponse({
    picked: {
      ok: true,
      route,
      upstream: new Response(CREDIT_BODY, { status: upstreamStatus, headers: { "content-type": "application/json" } }),
      acquirePromise: Promise.resolve({ ok: true, lease: { complete: (o) => leaseOutcomes.push(o), abandon() {} } }),
      attemptedChannels: [7],
      attemptedChannelNames: ["channel-7"],
      skippedChannelNames: [],
      redeemBalanceId: null,
    },
    requestHeaders: new Headers(),
    auth: { user: makeUser(), key: { id: 9, key: "sk-harness" } },
    alias: "target",
    inboundProtocol: "chat_completions",
    stream,
    startedAt: Date.now(),
    estimatedTokens: 1,
    localPromptTokens: 1,
    upstreamBody: { model: "target", messages: [] },
    clientIp: "127.0.0.1",
    clientUserAgent: null,
    substitutionNote: null,
    withQuotaHeaders: (r) => r,
    adaptResponseBodyForRoute: (raw) => raw,
    getUsageForRoute: () => null,
    extractCompletionTextForRoute: () => "",
    extractReasoningTextForRoute: () => "",
    createTransformedStreamForRoute: (body) => ({ stream: body, usage: () => null, completionText: () => "", reasoningText: () => "", firstTokenAt: () => null }),
    countsAsChannelFailureFor: createChannelFailureJudge(null),
  });

  // 消费流以触发 start() 里的熔断计入
  await response.text().catch(() => "");
  return { leaseOutcomes, response };
}

// A) 模型级配 400：上游 400 必须计为渠道失败
{
  const { leaseOutcomes } = await drive({ route: makeRoute({ modelRetryStatusCodes: JSON.stringify([400]) }) });
  check("queued：模型级配 400 计为渠道失败", leaseOutcomes[0]?.ok, false);
}

// B) 未配置 400：不该误记熔断
{
  const { leaseOutcomes } = await drive({ route: makeRoute() });
  check("queued：未配置 400 不计渠道失败", leaseOutcomes[0]?.ok, true);
}

// C) 渠道级配 400、模型级未配置：回落渠道级计入
{
  const { leaseOutcomes } = await drive({ route: makeRoute({ channelRetryStatusCodes: JSON.stringify([400]) }) });
  check("queued：渠道级配 400 计为渠道失败", leaseOutcomes[0]?.ok, false);
}

// D) 模型级 418 压过渠道级 400：400 不计入
{
  const { leaseOutcomes } = await drive({ route: makeRoute({ modelRetryStatusCodes: JSON.stringify([418]), channelRetryStatusCodes: JSON.stringify([400]) }) });
  check("queued：模型级 418 压过渠道级 400", leaseOutcomes[0]?.ok, true);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);

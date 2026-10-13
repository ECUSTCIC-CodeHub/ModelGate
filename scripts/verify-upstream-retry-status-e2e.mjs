// 端到端验证「按状态码换渠道」：模型级 > 渠道级 > 全局默认 > 内置默认。
// 运行：
//   node --experimental-transform-types --loader ./scripts/verify-retry-status-loader.mjs \
//     scripts/verify-upstream-retry-status-e2e.mjs
import { requestUpstreamWithFallback } from "@/lib/gateway/upstream-routing";
import { shouldRetryUpstreamStatus } from "@/lib/gateway/upstream-error";

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    passed += 1;
    return;
  }
  failed += 1;
  console.log(`  FAIL  ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function makeRoute({ channelId, modelId, retryStatusCodes = null, modelRetryStatusCodes = null }) {
  return {
    channel: {
      id: channelId,
      name: `channel-${channelId}`,
      base_url: "https://upstream.invalid",
      max_concurrency: 0,
      retry_status_codes: retryStatusCodes,
    },
    model: {
      id: modelId,
      alias: "target",
      real_model: `real-${modelId}`,
      quota_mode: "none",
      max_concurrency: 0,
      retry_status_codes: modelRetryStatusCodes,
    },
    effective_upstream_protocol: "chat_completions",
  };
}

function makeDeps({ routes, fetchImpl }) {
  const attempted = [];
  return {
    attempted,
    deps: {
      listModelRoutes: async (alias, options) => {
        const exC = new Set(options?.excludeChannelIds ?? []);
        const exM = new Set(options?.excludeModelIds ?? []);
        const ok = (r) => !exC.has(r.channel.id) && !exM.has(r.model.id);
        const exact = routes.filter((r) => r.model.alias === alias).filter(ok);
        return exact.length > 0 ? exact : routes.filter((r) => r.model.alias === "*").filter(ok);
      },
      checkChannelQuota: async () => ({ ok: true, quota: null }),
      checkModelQuota: async () => ({ ok: true, quota: { limit: null, used: 0, remaining: null } }),
      acquireChannel: (key) => ({ ok: true, lease: { key, complete() {}, abandon() {} } }),
      fetchUpstreamRequest: async (route) => {
        attempted.push(route.channel.id);
        return fetchImpl(route);
      },
      shouldRetryUpstreamStatus,
    },
  };
}

async function run({ routes, fetchImpl, maxRouteAttempts = 3, defaultRetryStatusCodes = null, sameChannelRetry = false }) {
  const h = makeDeps({ routes, fetchImpl });
  const result = await requestUpstreamWithFallback({
    resolvedAlias: "target",
    inboundProtocol: "chat_completions",
    maxRouteAttempts,
    sameChannelRetry,
    defaultRetryStatusCodes,
    requestSignal: new AbortController().signal,
    inboundHeaders: new Headers(),
    startedAt: Date.now(),
    estimatedTokens: 1,
    buildRequestBody: () => ({ model: "x" }),
    deps: h.deps,
  });
  return { result, attempted: h.attempted };
}

const CREDIT_BODY = JSON.stringify({
  error: { message: "You have insufficient credits to make this request." },
});

// 渠道 7 返回 status，渠道 8 始终成功
function failThenSucceed(status, routes) {
  return {
    routes,
    fetchImpl: (route) =>
      route.channel.id === 8
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response(CREDIT_BODY, { status }),
  };
}

console.log("=== A. 默认配置：400 额度报文不换渠道（文本不再参与判定）===");
{
  const routes = [makeRoute({ channelId: 7, modelId: 101 }), makeRoute({ channelId: 8, modelId: 102 })];
  const { result, attempted } = await run(failThenSucceed(400, routes));
  check("只打了渠道 7", JSON.stringify(attempted), JSON.stringify([7]));
  // 不换渠道时把上游响应原样透传给客户端（网关不吞 4xx），因此 ok 为 true 且状态码为 400
  check("透传上游响应", result.ok, true);
  check("状态码为 400", result.upstream?.status, 400);
  check("落到渠道 7", result.route?.channel.id, 7);
}

console.log("=== B. 默认配置：401 换到下一个渠道 ===");
{
  const routes = [makeRoute({ channelId: 7, modelId: 101 }), makeRoute({ channelId: 8, modelId: 102 })];
  const { result, attempted } = await run(failThenSucceed(401, routes));
  check("打了 7 后换到 8", JSON.stringify(attempted), JSON.stringify([7, 8]));
  check("最终成功", result.ok, true);
  check("落到渠道 8", result.route?.channel.id, 8);
}

console.log("=== C. 默认配置：5xx 换渠道 ===");
for (const status of [500, 502, 503, 504]) {
  const routes = [makeRoute({ channelId: 7, modelId: 101 }), makeRoute({ channelId: 8, modelId: 102 })];
  const { result, attempted } = await run(failThenSucceed(status, routes));
  check(`${status} 换到 8`, JSON.stringify(attempted), JSON.stringify([7, 8]));
  check(`${status} 最终成功`, result.ok, true);
}

console.log("=== D. 渠道级配置含 400：换渠道 ===");
{
  const routes = [
    makeRoute({ channelId: 7, modelId: 101, retryStatusCodes: JSON.stringify([400]) }),
    makeRoute({ channelId: 8, modelId: 102, retryStatusCodes: JSON.stringify([400]) }),
  ];
  const { result, attempted } = await run(failThenSucceed(400, routes));
  check("400 换到 8", JSON.stringify(attempted), JSON.stringify([7, 8]));
  check("最终成功", result.ok, true);
}

console.log("=== E. 渠道级配置优先于全局默认 ===");
{
  // 全局把 400 加进来，但渠道 7 自己只认 418；400 不该换
  const routes7Only = [makeRoute({ channelId: 7, modelId: 101, retryStatusCodes: JSON.stringify([418]) })];
  const { result, attempted } = await run({
    ...failThenSucceed(400, routes7Only),
    defaultRetryStatusCodes: [400],
  });
  check("渠道配置覆盖全局：400 不换", JSON.stringify(attempted), JSON.stringify([7]));
  check("透传上游 400", result.upstream?.status, 400);

  // 反过来：全局为空(默认)，渠道配 400 → 换
  const routes = [
    makeRoute({ channelId: 7, modelId: 101, retryStatusCodes: JSON.stringify([400]) }),
    makeRoute({ channelId: 8, modelId: 102 }),
  ];
  const r2 = await run(failThenSucceed(400, routes));
  check("渠道配 400 时换", JSON.stringify(r2.attempted), JSON.stringify([7, 8]));
}

console.log("=== F. 全局默认生效（渠道未配置）===");
{
  const routes = [makeRoute({ channelId: 7, modelId: 101 }), makeRoute({ channelId: 8, modelId: 102 })];
  const { result, attempted } = await run({
    ...failThenSucceed(400, routes),
    defaultRetryStatusCodes: [400],
  });
  check("全局含 400 时换", JSON.stringify(attempted), JSON.stringify([7, 8]));
  check("最终成功", result.ok, true);
}

console.log("=== G. 渠道脏数据不影响请求 ===");
for (const dirty of ["not-json", "{oops", '{"a":1}', "[200,600]", "[]", ""]) {
  const routes = [
    makeRoute({ channelId: 7, modelId: 101, retryStatusCodes: dirty }),
    makeRoute({ channelId: 8, modelId: 102 }),
  ];
  const { attempted } = await run(failThenSucceed(401, routes));
  check(`脏值 ${JSON.stringify(dirty)} 回落默认仍换 401`, JSON.stringify(attempted), JSON.stringify([7, 8]));
}

console.log("=== H. 候选耗尽：两渠道都失败 ===");
{
  const routes = [
    makeRoute({ channelId: 7, modelId: 101, retryStatusCodes: JSON.stringify([400]) }),
    makeRoute({ channelId: 8, modelId: 102, retryStatusCodes: JSON.stringify([400]) }),
  ];
  const { result, attempted } = await run({
    routes,
    fetchImpl: () => new Response(CREDIT_BODY, { status: 400 }),
  });
  check("两个渠道都被尝试", JSON.stringify(attempted), JSON.stringify([7, 8]));
  check("返回失败", result.ok, false);
  check("保留最后一次状态码", result.lastUpstreamStatus, 400);
}

console.log("=== I. maxRouteAttempts=1 时不换渠道 ===");
{
  const routes = [
    makeRoute({ channelId: 7, modelId: 101, retryStatusCodes: JSON.stringify([400]) }),
    makeRoute({ channelId: 8, modelId: 102, retryStatusCodes: JSON.stringify([400]) }),
  ];
  const { attempted } = await run({ ...failThenSucceed(400, routes), maxRouteAttempts: 1 });
  check("只打一次", JSON.stringify(attempted), JSON.stringify([7]));
}

console.log("=== J. 失败响应体不被预读消耗，透传完整 ===");
{
  // 不配置换渠道时上游错误体会原样透传，必须能完整读回（预读会把它消费掉）
  const routes = [makeRoute({ channelId: 7, modelId: 101 })];
  const { result } = await run(failThenSucceed(400, routes));
  const text = await result.upstream.text();
  check("错误响应体可完整读回", text, CREDIT_BODY);
  check("错误状态码保留", result.upstream.status, 400);

  // 换渠道场景下，最终成功的响应体同样必须完整可读
  const routes2 = [
    makeRoute({ channelId: 7, modelId: 101, retryStatusCodes: JSON.stringify([400]) }),
    makeRoute({ channelId: 8, modelId: 102 }),
  ];
  const { result: r2 } = await run(failThenSucceed(400, routes2));
  check("换渠道后成功响应体可读", await r2.upstream.text(), JSON.stringify({ ok: true }));
}

console.log("=== K. 大响应体不再被预读（无读放大）===");
{
  const big = "x".repeat(4 * 1024 * 1024);
  const routes = [
    makeRoute({ channelId: 7, modelId: 101, retryStatusCodes: JSON.stringify([400]) }),
    makeRoute({ channelId: 8, modelId: 102 }),
  ];
  const startedAt = Date.now();
  const { result, attempted } = await run({
    routes,
    fetchImpl: (route) => {
      if (route.channel.id === 8) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      const encoded = new TextEncoder().encode(big);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      });
      return new Response(stream, { status: 400 });
    },
  });
  const elapsed = Date.now() - startedAt;
  check("4MB 4xx 仍换渠道", JSON.stringify(attempted), JSON.stringify([7, 8]));
  check("最终成功", result.ok, true);
  console.log(`  INFO  4MB 上游 4xx 换渠道耗时 ${elapsed}ms（无预读，不读取大 body）`);
}


console.log("=== L0. 模型级配置：同渠道下不同模型各自生效 ===");
{
  // 同一渠道(7)两个模型，101 配 400、102 不配；400 应只对 101 换渠道
  const routesA = [
    makeRoute({ channelId: 7, modelId: 101, modelRetryStatusCodes: JSON.stringify([400]) }),
    makeRoute({ channelId: 8, modelId: 102 }),
  ];
  const rA = await run(failThenSucceed(400, routesA));
  check("模型配 400 时换到 8", JSON.stringify(rA.attempted), JSON.stringify([7, 8]));
  check("模型配 400 最终成功", rA.result.ok, true);

  const routesB = [
    makeRoute({ channelId: 7, modelId: 101 }),
    makeRoute({ channelId: 8, modelId: 102 }),
  ];
  const rB = await run(failThenSucceed(400, routesB));
  check("模型未配置时不换", JSON.stringify(rB.attempted), JSON.stringify([7]));
  check("模型未配置时透传 400", rB.result.upstream?.status, 400);
}

console.log("=== L0b. 模型级优先于渠道级与全局 ===");
{
  // 渠道配 400 允许换，但模型自己只认 418：400 不该换
  const routes = [
    makeRoute({ channelId: 7, modelId: 101, retryStatusCodes: JSON.stringify([400]), modelRetryStatusCodes: JSON.stringify([418]) }),
    makeRoute({ channelId: 8, modelId: 102 }),
  ];
  const r1 = await run(failThenSucceed(400, routes));
  check("模型覆盖渠道：400 不换", JSON.stringify(r1.attempted), JSON.stringify([7]));
  const r2 = await run(failThenSucceed(418, routes));
  check("模型覆盖渠道：418 换", JSON.stringify(r2.attempted), JSON.stringify([7, 8]));

  // 模型配 400、渠道未配：模型生效（渠道空则回落全局默认，400 默认不换）
  const routes2 = [
    makeRoute({ channelId: 7, modelId: 101, modelRetryStatusCodes: JSON.stringify([400]) }),
    makeRoute({ channelId: 8, modelId: 102 }),
  ];
  const r3 = await run(failThenSucceed(400, routes2));
  check("模型在渠道未配置时生效", JSON.stringify(r3.attempted), JSON.stringify([7, 8]));

  // 模型与渠道都未配置，全局含 400 → 换
  const bare = [
    makeRoute({ channelId: 7, modelId: 101 }),
    makeRoute({ channelId: 8, modelId: 102 }),
  ];
  const r4 = await run({ ...failThenSucceed(400, bare), defaultRetryStatusCodes: [400] });
  check("模型渠道都未配置回落全局", JSON.stringify(r4.attempted), JSON.stringify([7, 8]));
}

console.log("=== L0c. 模型脏数据回落渠道/全局，不影响请求 ===");
for (const dirty of ["not-json", "{oops", '{"a":1}', "[200,600]", "", "[]"]) {
  const routes = [
    makeRoute({ channelId: 7, modelId: 101, retryStatusCodes: JSON.stringify([400]), modelRetryStatusCodes: dirty }),
    makeRoute({ channelId: 8, modelId: 102 }),
  ];
  const { attempted } = await run(failThenSucceed(400, routes));
  check(`模型脏值 ${JSON.stringify(dirty)} 回落渠道仍换 400`, JSON.stringify(attempted), JSON.stringify([7, 8]));
}

console.log("=== L0d. 模型级配置不改变 5xx 与未配置 4xx 的默认行为 ===");
{
  const routes = [
    makeRoute({ channelId: 7, modelId: 101, modelRetryStatusCodes: JSON.stringify([418]) }),
    makeRoute({ channelId: 8, modelId: 102 }),
  ];
  const r1 = await run(failThenSucceed(503, routes));
  check("模型配 418 时 503 仍换", JSON.stringify(r1.attempted), JSON.stringify([7, 8]));
  const r2 = await run(failThenSucceed(404, routes));
  check("模型配 418 时 404 不换", JSON.stringify(r2.attempted), JSON.stringify([7]));
}

console.log("=== L0e. 同渠道重试分支同样认模型级配置 ===");
{
  // 只有一个候选且开启同渠道重试时，走的是 lastRequestedRoute 那条分支。
  // 模型级配 400 → 应在同一渠道(7)重试；上游始终 400，故重试满 maxRouteAttempts 次。
  const routes = [makeRoute({ channelId: 7, modelId: 101, modelRetryStatusCodes: JSON.stringify([400]) })];
  const r1 = await run({
    routes,
    sameChannelRetry: true,
    maxRouteAttempts: 3,
    fetchImpl: () => new Response(CREDIT_BODY, { status: 400 }),
  });
  check("模型配 400 时同渠道重试", JSON.stringify(r1.attempted), JSON.stringify([7, 7, 7]));

  // 模型未配置 400 → 不重试，只打一次
  const routes2 = [makeRoute({ channelId: 7, modelId: 101 })];
  const r2 = await run({
    routes: routes2,
    sameChannelRetry: true,
    maxRouteAttempts: 3,
    fetchImpl: () => new Response(CREDIT_BODY, { status: 400 }),
  });
  check("模型未配置时同渠道不重试", JSON.stringify(r2.attempted), JSON.stringify([7]));

  // 渠道级配 400、模型级未配置 → 模型回落渠道，仍应重试
  const routes3 = [makeRoute({ channelId: 7, modelId: 101, retryStatusCodes: JSON.stringify([400]) })];
  const r3 = await run({
    routes: routes3,
    sameChannelRetry: true,
    maxRouteAttempts: 3,
    fetchImpl: () => new Response(CREDIT_BODY, { status: 400 }),
  });
  check("模型未配置回落渠道后同渠道重试", JSON.stringify(r3.attempted), JSON.stringify([7, 7, 7]));
}

console.log("=== L. 渠道写错的状态码不被当成合法配置（严格解析）===");
{
  // 非 JSON 文本：按未配置处理并回落默认
  const bad1 = [makeRoute({ channelId: 7, modelId: 101, retryStatusCodes: "400abc" }), makeRoute({ channelId: 8, modelId: 102 })];
  const r1 = await run(failThenSucceed(400, bad1));
  check("非 JSON 脏值不触发 400 换渠道", JSON.stringify(r1.attempted), JSON.stringify([7]));
  check("非 JSON 脏值透传上游 400", r1.result.upstream?.status, 400);

  // 合法 JSON 但元素是脏值：绝不能静默变成 400（parseInt 会截断成 400）
  const bad2 = [makeRoute({ channelId: 7, modelId: 101, retryStatusCodes: '["400abc"]' }), makeRoute({ channelId: 8, modelId: 102 })];
  const r2 = await run(failThenSucceed(400, bad2));
  check("JSON 内脏值不触发 400 换渠道", JSON.stringify(r2.attempted), JSON.stringify([7]));
  check("JSON 内脏值透传上游 400", r2.result.upstream?.status, 400);

  // 混入脏值时必须只保留合法项
  const mixed = [makeRoute({ channelId: 7, modelId: 101, retryStatusCodes: '["400abc", 418]' }), makeRoute({ channelId: 8, modelId: 102 })];
  const r3 = await run(failThenSucceed(400, mixed));
  check("只保留合法项：400 不换", JSON.stringify(r3.attempted), JSON.stringify([7]));
  const r4 = await run(failThenSucceed(418, mixed));
  check("只保留合法项：418 换", JSON.stringify(r4.attempted), JSON.stringify([7, 8]));
}

console.log("=== M. 熔断口径与换渠道一致（渠道配置 [400]）===");
{
  // 配了 400 会换渠道，就必须同时计入熔断，否则渠道会被反复选中。
  // 断言写死期望值，不做「a === b」式别名比对，否则两边同时错也测不出来。
  const { countsAsChannelFailure, resolveRetryStatusCodes } = await import("@/lib/gateway/upstream-error");
  const effective = resolveRetryStatusCodes(null, JSON.stringify([400]), null);
  check("生效列表含 400", JSON.stringify(effective), JSON.stringify([400]));
  check("配置 400 计入熔断", countsAsChannelFailure(400, effective), true);
  check("配置 400 时 400 换渠道", shouldRetryUpstreamStatus(400, effective), true);
  check("未配置的 404 不计熔断", countsAsChannelFailure(404, effective), false);
  check("未配置的 404 不换渠道", shouldRetryUpstreamStatus(404, effective), false);
  check("5xx 始终计熔断", countsAsChannelFailure(503, effective), true);
  check("5xx 始终换渠道", shouldRetryUpstreamStatus(503, effective), true);
  check("2xx 不计熔断", countsAsChannelFailure(200, effective), false);
}


console.log("=== N. 熔断计入点必须走渠道配置（源码级守卫）===");
{
  // 4xx 的可达分支若硬编码 ok: false，会给未配置渠道误记熔断失败次数。
  // 这里按源码结构检查：status >= 400 分支里的 lease.complete 必须用 countsAsChannelFailureFor。
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = (await import("node:path")).default;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const rel of ["lib/gateway/gateway-handler.ts", "lib/gateway/queued-upstream-response.ts"]) {
    const source = readFileSync(path.join(root, rel), "utf8").split("\n");
    const offenders = [];
    for (let i = 0; i < source.length; i += 1) {
      if (source[i].includes("upstream.status >= 400")) {
        // 该分支内（含嵌套一层）的 lease.complete 不得硬编码 ok: false
        for (let j = i + 1; j < Math.min(i + 30, source.length); j += 1) {
          if (source[j].includes("lease.complete")) {
            if (!source[j].includes("countsAsChannelFailureFor")) offenders.push(j + 1);
            break;
          }
        }
      }
    }
    check(`${rel} 无硬编码 ok: false`, JSON.stringify(offenders), JSON.stringify([]));
  }
}

console.log("=== O. 调用点必须把模型级配置传下去（源码级守卫）===");
{
  // 换渠道与熔断的判定都靠调用点把 route.model.retry_status_codes 传进解析函数。
  // 只在 resolveRetryStatusCodes 内部测「模型优先」抓不到调用点写死 null 的回归，
  // 这里按源码结构检查：所有 resolveRetryStatusCodes 调用都必须带 route.model 的模型值。
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = (await import("node:path")).default;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const rel of ["lib/gateway/gateway-handler.ts", "lib/gateway/upstream-routing.ts"]) {
    const source = readFileSync(path.join(root, rel), "utf8");
    const calls = source.match(/resolveRetryStatusCodes\([^)]*\)/g) ?? [];
    const withoutModel = calls.filter((call) => !call.includes(".model.retry_status_codes"));
    check(`${rel} 全部调用点带模型级配置`, JSON.stringify(withoutModel), JSON.stringify([]));
    check(`${rel} 至少有一处调用`, calls.length > 0, true);
  }
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);

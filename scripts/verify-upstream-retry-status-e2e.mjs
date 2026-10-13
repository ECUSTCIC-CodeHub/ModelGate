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


console.log("=== N. 4xx 分支的熔断计入不得硬编码（AST 级守卫）===");
{
  // 4xx 的可达分支若硬编码 ok: false，会给未配置渠道误记熔断失败次数。
  // 用 AST 定位 `upstream.status >= 400` 分支内的 lease.complete，断言 ok 的取值
  // 只能来自 countsAsChannelFailureFor 取反（或明确的 true），避免被注释夹带绕过。
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = (await import("node:path")).default;
  const ts = (await import("typescript")).default;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const rel of ["lib/gateway/gateway-handler.ts", "lib/gateway/queued-upstream-response.ts"]) {
    const source = readFileSync(path.join(root, rel), "utf8");
    const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const offenders = [];
    const isStatusGuard = (node) =>
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken
      && node.left.getText(sourceFile) === "upstream.status"
      && node.right.getText(sourceFile) === "400";
    const checkLeaseComplete = (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression.getText(sourceFile);
      if (callee !== "lease.complete") return;
      const arg = node.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) return;
      const okProp = arg.properties.find((prop) => ts.isPropertyAssignment(prop) && prop.name.getText(sourceFile) === "ok");
      const okText = okProp && ts.isPropertyAssignment(okProp) ? okProp.initializer.getText(sourceFile) : "";
      // 允许：!countsAsChannelFailureFor(...) 或 true
      const allowed = /^!countsAsChannelFailureFor\(/.test(okText) || okText === "true";
      if (!allowed) {
        offenders.push(`${okText || "<无 ok>"} @ 行 ${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`);
      }
    };
    const visit = (node) => {
      if (ts.isIfStatement(node) && isStatusGuard(node.expression) && node.thenStatement) {
        const walk = (inner) => {
          checkLeaseComplete(inner);
          ts.forEachChild(inner, walk);
        };
        walk(node.thenStatement);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    check(`${rel} 4xx 分支无硬编码 ok`, JSON.stringify(offenders), JSON.stringify([]));
  }
}

console.log("=== O. 熔断计入必须认模型级配置（运行时断言）===");
{
  // 这里直接喂真实形状的 route 对象跑熔断判定函数本身，验证四级回落语义。
  // 覆盖边界：本组只测判定函数的行为，不承载「调用点有没有接线」——
  // 调用点接线由 P 组（含 gateway-handler 闭包与 queued-upstream-response 的
  // 3 个熔断计入点）与 L/L0e 组（换渠道的实际换渠道路径）负责。
  const { routeCountsAsChannelFailure } = await import("@/lib/gateway/upstream-error");
  const model400 = { model: { retry_status_codes: JSON.stringify([400]) }, channel: { retry_status_codes: null } };
  const channel418 = { model: { retry_status_codes: null }, channel: { retry_status_codes: JSON.stringify([418]) } };
  const modelOverChannel = { model: { retry_status_codes: JSON.stringify([400]) }, channel: { retry_status_codes: JSON.stringify([418]) } };
  const empty = { model: { retry_status_codes: null }, channel: { retry_status_codes: null } };

  check("模型级配 400：400 计熔断", routeCountsAsChannelFailure(model400, 400, null), true);
  check("模型级配 400：404 不计熔断", routeCountsAsChannelFailure(model400, 404, null), false);
  check("模型级未配置、渠道配 418：418 计熔断", routeCountsAsChannelFailure(channel418, 418, null), true);
  check("模型级未配置、渠道配 418：400 不计熔断", routeCountsAsChannelFailure(channel418, 400, null), false);
  // 模型级必须压过渠道级：这正是「同渠道不同模型行为不同」的核心诉求
  check("模型级压过渠道级：400 计熔断", routeCountsAsChannelFailure(modelOverChannel, 400, null), true);
  check("模型级压过渠道级：418 不计熔断", routeCountsAsChannelFailure(modelOverChannel, 418, null), false);
  check("两者都未配置：回落全局默认 401 计熔断", routeCountsAsChannelFailure(empty, 401, [401, 402]), true);
  check("两者都未配置：400 不计熔断", routeCountsAsChannelFailure(empty, 400, [401, 402]), false);
  check("5xx 恒计熔断", routeCountsAsChannelFailure(empty, 503, null), true);
  check("2xx 不计熔断", routeCountsAsChannelFailure(model400, 200, null), false);
}

console.log("=== P. 调用点必须把路由对象本身交给判定（TypeChecker 级守卫）===");
{
  // 覆盖面：gateway-handler.ts 的熔断闭包 + queued-upstream-response.ts 的 3 个熔断计入点。
  // 断言语义（不是名字，也不是字面文本）：首参标识符最终必须绑定到
  //   (a) 所在函数的形参（路由对象由调用方注入），或
  //   (b) 从已知路由容器（如 picked）解构而来。
  // 只要中途出现「本地重造的同名对象」（对象字面量、展开重造、别名二次解构、
  // as any 等），绑定来源就不再是形参/已知容器，一律判失败 —— 不需要维护名字白名单。
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = (await import("node:path")).default;
  const ts = (await import("typescript")).default;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  // 允许作为「路由来源」的容器名：这些标识符本身就是路由对象或其持有者，
  // 从它们解构出路由名视为合法。新增路由容器时必须同步登记。
  const ROUTE_CONTAINERS = new Set(["picked"]);

  // 已知产出路由容器的工厂：从它们的返回值解构出的路由对象可信。
  // 用于识别 `const picked = await requestUpstreamWithFallback({...})` 这类绑定 ——
  // 容器不是函数形参，但来源是网关自己的路由层，不是就地重造。
  //
  // 信任按「符号绑定」给，不按名字文本给：必须解析到本文件顶部的 import 声明
  // （ImportSpecifier），且导入来源是网关路由层。只比对 `init.expression.text`
  // 时，局部 `const requestUpstreamWithFallback = ...` 同名遮蔽即可放行 ——
  // 被遮蔽的假工厂出参解构出的 `route` 会静默通过两层守卫。
  const ROUTE_FACTORY_MODULES = new Set(["@/lib/gateway/upstream-routing"]);
  const ROUTE_FACTORIES = new Set(["requestUpstreamWithFallback"]);

  // 该标识别名是否绑定到「本文件从路由层 import 进来的工厂」。
  // 解析到本文件 VariableDeclaration（即同名遮蔽）必然被拒。
  const isImportedRouteFactory = (checker, sourceFile, ident) => {
    const symbol = checker.getSymbolAtLocation(ident);
    if (!symbol) return false;
    const decls = symbol.declarations || [];
    if (decls.length !== 1) return false;
    const decl = decls[0];
    if (!ts.isImportSpecifier(decl)) return false;
    const imported = decl.propertyName ?? decl.name;
    if (!ROUTE_FACTORIES.has(imported.text)) return false;
    const namedImports = decl.parent;
    const importClause = namedImports && namedImports.parent;
    const importDecl = importClause && importClause.parent;
    const moduleText = importDecl && ts.isImportDeclaration(importDecl) && ts.isStringLiteral(importDecl.moduleSpecifier)
      ? importDecl.moduleSpecifier.text
      : null;
    return Boolean(moduleText && ROUTE_FACTORY_MODULES.has(moduleText));
  };

  // 判断某声明节点是否为「受信任的路由容器绑定」：
  // 形参，或 `const X = <路由工厂>(...)` / `await <路由工厂>(...)`，
  // 其中路由工厂必须按符号绑定确认是 import 进来的那个（同名遮蔽不算）。
  const isTrustedRouteContainerBinding = (checker, sourceFile, decl) => {
    if (isParameterBinding(decl)) return true;
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) return false;
    let init = decl.initializer;
    if (ts.isAwaitExpression(init)) init = init.expression;
    if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return false;
    return isImportedRouteFactory(checker, sourceFile, init.expression);
  };

  const cfg = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  const parseSettings = { ...parsed.options, noEmit: true, skipLibCheck: true, incremental: false };

  // 缓存 program，避免每个文件重复全量解析
  const programCache = new Map();
  const getProgram = (absFiles) => {
    const key = absFiles.join("|");
    if (!programCache.has(key)) {
      programCache.set(key, ts.createProgram(absFiles, parseSettings));
    }
    return programCache.get(key);
  };

  // 判断某个标识符 symbol 的「绑定来源」是否为合法路由来源。
  // 返回 null 表示合法；返回字符串表示失败原因。
  // 是否绑定在函数形参上：直接是 Parameter，或是形参解构模式里的 BindingElement
  // （`{ picked }` 这种对象解构形参，符号声明落在 BindingElement 上，祖父才是 Parameter）。
  const isParameterBinding = (decl) => {
    if (ts.isParameter(decl)) return true;
    if (ts.isBindingElement(decl)) {
      const pattern = decl.parent;
      const holder = pattern && pattern.parent;
      return !!holder && ts.isParameter(holder);
    }
    return false;
  };

  const traceRouteOrigin = (checker, ident, sourceFile, seen) => {
    const symbol = checker.getSymbolAtLocation(ident);
    if (!symbol) return `${ident.text}（无绑定）`;
    const decls = (symbol.declarations || []).filter((d) => d.getSourceFile() === sourceFile);
    if (decls.length === 0) return `${ident.text}（非本文件绑定）`;
    if (decls.length > 1) return `${ident.text}（同名多次绑定）`;
    const decl = decls[0];

    // (a) 函数形参：路由对象由调用方注入，合法
    if (isParameterBinding(decl)) return null;

    // (b) 解构绑定（`const { route } = X`）：符号落在 BindingElement 上，
    // 要顺着 X 递归校验来源对象本身也是合法路由来源。
    if (ts.isBindingElement(decl)) {
      const bindingPattern = decl.parent;
      const varDecl = bindingPattern && bindingPattern.parent;
      if (!varDecl || !ts.isVariableDeclaration(varDecl)) return `${ident.text}（解构节点异常）`;
      const initializer = varDecl.initializer;
      if (!initializer) return `${ident.text}（解构无来源）`;
      // 先跟随别名：来源自身若是中间标识符（picked2 / shadow），递归追溯。
      // 已知容器名必须解析到「函数形参」，同名局部重声明不算通过 —— 否则
      // `const picked = {...重造...}; const { route } = picked` 会按名字蒙混过关。
      let source = initializer;
      while (ts.isIdentifier(source)) {
        if (seen.has(source.text)) return `${ident.text}（来源链自引用）`;
        seen.add(source.text);
        const srcSym = checker.getSymbolAtLocation(source);
        const srcDecl = srcSym && (srcSym.declarations || []).find((d) => d.getSourceFile() === sourceFile);
        // 受信任容器：期望的名字必须解析到受信任绑定（形参或路由工厂出参），
        // 否则同名局部重声明会按名字蒙混过关。
        if (srcDecl && isTrustedRouteContainerBinding(checker, sourceFile, srcDecl)) {
          if (ROUTE_CONTAINERS.has(source.text)) return null;
          return `${ident.text}（解构自受信任绑定 ${source.text}，来源不可信）`;
        }
        if (ROUTE_CONTAINERS.has(source.text)) return `${ident.text}（来源名 ${source.text} 非受信任绑定，疑似遮蔽）`;
        if (srcDecl && ts.isVariableDeclaration(srcDecl) && srcDecl.initializer) {
          source = srcDecl.initializer;
          continue;
        }
        return `${ident.text}（来源标识符 ${source.text} 未追溯到路由容器）`;
      }
      // 来源是对象字面量（含展开重造）-> 视为重造
      if (ts.isObjectLiteralExpression(source)) return `${ident.text}（解构自重造对象字面量）`;
      return `${ident.text}（解构来源不可信：${source.getText(sourceFile).slice(0, 40)}）`;
    }

    return `${ident.text}（绑定节点非形参/解构）`;
  };

  // 对单个源文件收集所有「首参未绑定到合法路由来源」的违规（返回违规描述数组）
  const collectOffenders = (sourceFile, checker, calleeNames) => {
    const offenders = [];
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && calleeNames.includes(node.expression.text)) {
        const first = node.arguments[0];
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        if (!first) {
          offenders.push(`<无首参> @ 行 ${line}`);
        } else if (!ts.isIdentifier(first)) {
          offenders.push(`${first.getText(sourceFile).slice(0, 40)}（非标识符）@ 行 ${line}`);
        } else {
          const reason = traceRouteOrigin(checker, first, sourceFile, new Set());
          if (reason) offenders.push(`${reason} @ 行 ${line}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return offenders;
  };

  // 统计源文件里指定 callee 名的调用次数（按名字分组）
  const countCallsByName = (sourceFile, names) => {
    const counts = new Map(names.map((name) => [name, 0]));
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && counts.has(node.expression.text)) {
        counts.set(node.expression.text, counts.get(node.expression.text) + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return counts;
  };

  // 校验某个判定函数在该文件里所有调用的首参，并逐个登记名断言命中数。
  // 命中数断言是接线检查：只看「至少有一处调用」时，登记名写错 / 漏登记会被
  // 同文件里另一处同族调用遮住 —— 守卫看着在跑，实际扫的是空靶子。
  const checkCalls = (rel, calleeNames, expectedHits) => {
    const abs = path.join(root, rel);
    const program = getProgram([abs]);
    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(abs);
    if (!sourceFile) {
      check(`${rel} 可解析`, false, true);
      return;
    }
    const offenders = collectOffenders(sourceFile, checker, calleeNames);
    check(`${rel} ${calleeNames.join("/")} 首参绑定到路由来源`, JSON.stringify(offenders), JSON.stringify([]));

    const counts = countCallsByName(sourceFile, calleeNames);
    for (const name of calleeNames) {
      const expected = expectedHits[name];
      if (expected === undefined) {
        check(`${rel} ${name} 已登记期望命中数`, false, true);
      } else {
        check(`${rel} ${name} 命中数`, counts.get(name) ?? 0, expected);
      }
    }
  };

  // 结构断言（拒绝面）：绑定来源追溯回答的是「这个符号最终是不是路由」，
  // 但它识破不了「把重造出的对象经由函数形参再交进去」这类形态 —— 形参在追溯里
  // 永远是合法来源。因此再叠一层结构断言：除「函数形参」和「块顶层
  // `const { route } = picked`」以外，目标文件里不得出现整路由对象的构造表达式，
  // 也不得出现来源不可信的路由解构。
  const ROUTE_NAME_SET = new Set(["route", "retryRoute", "candidate"]);
  const propKeyOf = (name) => (ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : "");

  // 整路由对象构造。路由模型结构是 { model, channel, effective_upstream_protocol }，
  // 「重造一份路由」必然满足其一：
  //   a) 带 route 属性（`{ route: Object.assign({}, route, {...}) }` 这类容器重造）
  //   b) 同时给出 model 与 channel 两个整对象
  //   c) 展开一个路由-ish 来源（`picked`、`picked.route`、名字含 route 的标识符）
  const isRouteObjectLiteral = (node) => {
    if (!ts.isObjectLiteralExpression(node)) return false;
    const routeish = (name) => name === "picked" || /route/i.test(name);
    const spreadFromRoute = (expr) => {
      if (ts.isIdentifier(expr)) return routeish(expr.text);
      if (ts.isPropertyAccessExpression(expr)) {
        const parts = [];
        let cursor = expr;
        while (ts.isPropertyAccessExpression(cursor)) {
          parts.unshift(cursor.name.text);
          cursor = cursor.expression;
        }
        if (ts.isIdentifier(cursor)) parts.unshift(cursor.text);
        return parts.some(routeish);
      }
      return false;
    };

    let routeSpread = false;
    let hasRouteProp = false;
    let wholeModel = false;
    let wholeChannel = false;
    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) {
        if (spreadFromRoute(prop.expression)) routeSpread = true;
        continue;
      }
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = propKeyOf(prop.name);
      const whole = prop.initializer;
      // 只有整对象（字面量或字段直取如 `route.model`）才算重建路由；
      // `{ model: route.model.real_model, channel: route.channel.name }` 这类标量取值是普通响应对象
      const isWholeObject =
        ts.isObjectLiteralExpression(whole) ||
        (ts.isPropertyAccessExpression(whole) &&
          (whole.name.text === "model" || whole.name.text === "channel" || whole.name.text === "route"));
      if (key === "route") hasRouteProp = true;
      if (key === "model" && isWholeObject) wholeModel = true;
      if (key === "channel" && isWholeObject) wholeChannel = true;
    }
    return routeSpread || hasRouteProp || (wholeModel && wholeChannel);
  };

  const isPickedSource = (node) => {
    if (!node) return false;
    if (ts.isIdentifier(node)) return node.text === "picked";
    if (ts.isPropertyAccessExpression(node)) return isPickedSource(node.expression);
    return false;
  };

  const collectStructuralOffenders = (sourceFile) => {
    const offenders = [];
    const walk = (node, ancestors) => {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const inType = ancestors.some((a) => ts.isTypeNode(a));

      if (!inType && isRouteObjectLiteral(node)) {
        offenders.push(`整路由对象构造 @ 行 ${line}`);
      }

      if (!inType && ts.isObjectBindingPattern(node)) {
        // 括号包裹的箭头函数形参会被 AST 合成一个同名对象解构声明，跳过以免重复判定
        const fromParenParam = (() => {
          let cursor = node.parent;
          while (cursor && (ts.isParenthesizedExpression(cursor) || ts.isParameter(cursor))) {
            if (ts.isParameter(cursor)) return true;
            cursor = cursor.parent;
          }
          return false;
        })();

        const named = node.elements.filter(
          (element) =>
            ts.isBindingElement(element) && ts.isIdentifier(element.name) && ROUTE_NAME_SET.has(element.name.text),
        );
        if (named.length > 0 && !fromParenParam) {
          const decl = ts.isVariableDeclaration(node.parent) ? node.parent : null;
          const list = decl && ts.isVariableDeclarationList(decl.parent) ? decl.parent : null;
          const stmt = list && ts.isVariableStatement(list.parent) ? list.parent : null;
          const block = stmt ? stmt.parent : null;
          // 合法形态：直接写在某个块（函数体或 if/循环块）顶层、单一 `const` 声明、
          // 初始值直接取自路由容器。嵌在回调 / IIFE / 中间对象里的解构拿不到
          // 「块顶层」这一形态，一律来源不可信。
          const inBlockTopLevel = Boolean(stmt && block && ts.isBlock(block) && list.declarations.length === 1);
          const legit = Boolean(decl && inBlockTopLevel && isPickedSource(decl.initializer));
          if (!legit) {
            offenders.push(`${named.map((element) => element.name.text).join("/")} 解构来源不可信 @ 行 ${line}`);
          }
        }
      }

      ts.forEachChild(node, (child) => walk(child, [...ancestors, node]));
    };
    walk(sourceFile, []);
    return offenders;
  };

  // 1a) 守卫自检：把历史上绕过过的形态锁进回归清单。
  //     在临时目录造合成源文件，用同一套 traceRouteOrigin 判定，
  //     合法形态必须放行、重造形态必须拦下 —— 守卫本身退化会立刻失败。
  {
    const fs = await import("node:fs");
    // 正例需要 import "@/lib/..." 才能解析到真实模块，因此临时目录必须落在仓库内，
    // 而仓库根的 tsconfig 已配置 paths 别名。用后立即删除，不留残留。
    const tmpDir = fs.mkdtempSync(path.join(root, ".tmp-route-guard-"));
    const mk = (name, body) => {
      const file = path.join(tmpDir, name);
      fs.writeFileSync(file, body);
      return file;
    };

    const CASES = [
      ["合法：形参直传", `declare function verdict(route: RoutedModel, status: number): boolean;\nconst f = (route: RoutedModel) => verdict(route, 400);`, false],
      ["合法：解构自受信任容器", `declare function verdict(route: RoutedModel, status: number): boolean;\nconst f = (picked: { route: RoutedModel }) => {\n  const { route } = picked;\n  return verdict(route, 400);\n};`, false],
      ["M3 命名重造 + 解构（本轮主攻）", `declare function verdict(route: RoutedModel, status: number): boolean;\nconst picked = {} as { route: RoutedModel };\nconst picked2 = { ...picked, route: { ...picked.route, model: {} } };\nconst { route } = picked2 as { route: RoutedModel };\nconst r = verdict(route, 400);`, true],
      ["M4 闭包入参改名 + 内部解构自重造", `declare function verdict(route: RoutedModel, status: number): boolean;\nconst f = (input: RoutedModel) => {\n  const shadow = { route: { ...input, model: {} } as RoutedModel };\n  const { route } = shadow;\n  return verdict(route, 400);\n};`, true],
      ["M6 同名解构后再用同名解构重绑", `declare function verdict(route: RoutedModel, status: number): boolean;\ndeclare const picked: { route: RoutedModel };\nconst { route: rawRoute } = picked;\nconst { route } = { route: { ...rawRoute, model: {} } };\nconst r = verdict(route, 400);`, true],
      ["对象字面量直传", `declare function verdict(route: RoutedModel, status: number): boolean;\nconst r = verdict({ ...({} as RoutedModel) }, 400);`, true],
      ["B1 对象解构形参 + 容器重造", `declare function verdict(route: RoutedModel, status: number): boolean;\nconst f = (route: RoutedModel) => {\n  const holder = { route: { ...route, model: {} } as RoutedModel };\n  return !(({ route }: { route: RoutedModel }) => verdict(route, 400))(holder);\n};`, true],
      ["B2 IIFE 形参 + 调用点重造", `declare function verdict(route: RoutedModel, status: number): boolean;\nconst f = (route: RoutedModel) => !((r: RoutedModel) => verdict(r, 400))({ ...route, model: {} });`, true],
      ["B2b IIFE 形参 + Object.assign 重造", `declare function verdict(route: RoutedModel, status: number): boolean;\nconst f = (route: RoutedModel) => {\n  const shadow = { route: Object.assign({}, route, { model: {} }) as RoutedModel };\n  return !(({ route }: { route: RoutedModel }) => verdict(route, 400))(shadow);\n};`, true],
      // 工厂信任必须按「符号绑定」判：名字文本相同的本地声明（同名遮蔽）不算工厂。
      // 生产代码里 `requestUpstreamWithFallback` 是 import 进来的，局部重声明会
      // 解析到本文件 VariableDeclaration/FunctionDeclaration，必须被拒。
      ["M7 同名遮蔽工厂名 + 出参解构（非字面量出参）", `declare function verdict(route: RoutedModel, status: number): boolean;\ndeclare const fake: { route: RoutedModel };\nconst requestUpstreamWithFallback = async (_o: unknown) => fake;\nconst picked = await requestUpstreamWithFallback({});\nconst { route } = picked;\nconst r = verdict(route, 400);`, true],
      ["M8 同名遮蔽工厂名（函数声明形态）", `declare function verdict(route: RoutedModel, status: number): boolean;\ndeclare const fake: { route: RoutedModel };\nfunction requestUpstreamWithFallback(_o: unknown) { return Promise.resolve(fake); }\nconst picked = await requestUpstreamWithFallback({});\nconst { route } = picked;\nconst r = verdict(route, 400);`, true],
      // 正例：从真实路由模块 import 的工厂出参必须放行 —— 证明信任判定不是死的。
      // 用真实相对路径 import，符号解析到 ImportSpecifier 且来源在受信任模块集合内。
      ["合法：import 的真实工厂出参解构", `import { requestUpstreamWithFallback } from "@/lib/gateway/upstream-routing";\nimport type { RoutedModel } from "@/lib/gateway/router";\ndeclare function verdict(route: RoutedModel, status: number): boolean;\nexport const f = async () => {\n  const picked = await requestUpstreamWithFallback({} as never);\n  const { route } = picked;\n  return verdict(route, 400);\n};`, false],
    ];

    for (const [index, [label, body, shouldReject]] of CASES.entries()) {
      const file = mk(`case-${index}.ts`, body + "\n");
      const program = getProgram([file]);
      const checker = program.getTypeChecker();
      const sourceFile = program.getSourceFile(file);
      // 两层守卫都要过：绑定来源追溯 + 拒绝面结构断言
      const offenders = [
        ...collectOffenders(sourceFile, checker, ["verdict"]),
        ...collectStructuralOffenders(sourceFile),
      ];
      const rejected = offenders.length > 0;
      check(`守卫自检 · ${label}`, rejected, shouldReject);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 1b) 接线自检：把「登记名必须在目标文件真实命中」这件事本身锁进回归清单。
  //     合成文件模拟本轮真实病根 —— 同名族分散在两个名字上：真实调用点用
  //     `closure`，而登记名写成只在定义体里出现的 `raw`。按名字分组计数必须
  //     如实报出「raw 命中 1、closure 命中 2」，才能证明漏登记会被发现。
  {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-wiring-"));
    const file = path.join(tmpDir, "wiring.ts");
    fs.writeFileSync(file, [
      "declare function raw(route: RoutedModel, status: number, codes?: number[] | null): boolean;",
      "declare const picked: { route: RoutedModel };",
      "const closure = (route: RoutedModel, status: number) => raw(route, status);",
      "const { route } = picked;",
      "const a = closure(route, 400);",
      "const b = closure(route, 401);",
      "",
    ].join("\n"));
    const program = getProgram([file]);
    const sourceFile = program.getSourceFile(file);
    const hits = countCallsByName(sourceFile, ["raw", "closure"]);
    check("接线自检 · 定义处名字命中数如实统计", hits.get("raw"), 1);
    check("接线自检 · 真实调用点名字命中数如实统计", hits.get("closure"), 2);
    check("接线自检 · 漏登记的名字命中 0", hits.get("missing") ?? 0, 0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 1) 熔断计入点接线。
  //    gateway-handler.ts 自带的 4 个熔断计入点用的是本地闭包名 countsAsChannelFailureFor；
  //    routeCountsAsChannelFailure 只在该文件的闭包定义体里出现 1 次。两个名字都必须登记，
  //    否则漏登记的那个名字会让 4 个真实调用点整片失守（本轮病根）。
  //    queued-upstream-response.ts 是注入式调用方，3 个熔断计入点用注入名。
  // 熔断判定器现由 createChannelFailureJudge 工厂产出（见 upstream-error.ts），
  // gateway-handler 内不再直接出现 routeCountsAsChannelFailure；真实调用点只剩 4 处，
  // 全用本地绑定名 countsAsChannelFailureFor。
  checkCalls("lib/gateway/gateway-handler.ts", ["countsAsChannelFailureFor"], {
    countsAsChannelFailureFor: 4,
  });
  checkCalls("lib/gateway/queued-upstream-response.ts", ["countsAsChannelFailureFor"], {
    countsAsChannelFailureFor: 3,
  });

  // 1b) 拒绝面断言：目标文件里不得出现整路由对象构造或来源不可信的路由解构
  for (const rel of ["lib/gateway/gateway-handler.ts", "lib/gateway/queued-upstream-response.ts"]) {
    const source = readFileSync(path.join(root, rel), "utf8");
    const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    check(`${rel} 无整路由对象重造`, JSON.stringify(collectStructuralOffenders(sourceFile)), JSON.stringify([]));
  }

  // 2) gateway-handler 不得回退到直调裸判定（绕过统一入口）
  {
    const rel = "lib/gateway/gateway-handler.ts";
    const source = readFileSync(path.join(root, rel), "utf8");
    const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let usesRaw = 0;
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "countsAsChannelFailure") usesRaw += 1;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    check(`${rel} 不再直调裸判定`, usesRaw, 0);
  }

  // 3) 换渠道判定：upstream-routing 的首参必须是模型级配置的直取
  {
    const rel = "lib/gateway/upstream-routing.ts";
    const source = readFileSync(path.join(root, rel), "utf8");
    const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const offenders = [];
    let callCount = 0;
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "resolveRetryStatusCodes") {
        callCount += 1;
        const first = node.arguments[0];
        const text = first ? first.getText(sourceFile).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").trim() : "";
        if (!/^[A-Za-z_$][\w$]*\.model\.retry_status_codes$/.test(text)) {
          offenders.push(`${text || "<无第 1 参>"} @ 行 ${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    check(`${rel} 首参为模型级配置`, JSON.stringify(offenders), JSON.stringify([]));
    check(`${rel} 至少有一处调用`, callCount > 0, true);
  }
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);

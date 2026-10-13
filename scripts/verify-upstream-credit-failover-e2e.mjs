// 端到端验证：上游以 400 返回「额度耗尽」时应自动换到同别名下一个渠道。
//
// 与 verify-upstream-candidate-loop.mjs 的区别：那里把 shouldRetryUpstreamStatus 也 stub 掉了，
// 因此测不到「按响应文本判定」这条新逻辑；这里注入真实实现，只 stub 选路/配额/上游请求。
//
// 运行：node --experimental-transform-types --loader ./scripts/verify-credit-failover-loader.mjs scripts/verify-upstream-credit-failover-e2e.mjs
// （必须用 verify-credit-failover-loader.mjs 而非 alias-loader.mjs：upstream-routing.ts
//   会经 proxy.ts 间接拉起 lib/core/http.ts 的 next/server，只有前者会 stub 掉这些重依赖。）
import { requestUpstreamWithFallback } from "@/lib/gateway/upstream-routing";
import { shouldRetryUpstreamStatus } from "@/lib/gateway/upstream-error";

const CREDIT_BODY = JSON.stringify({
  error: {
    message:
      "You have insufficient credits to make this request. Please purchase more credits to continue using the service.",
    type: "insufficient_credits",
    code: "insufficient_credits",
  },
});
const PARAM_BODY = JSON.stringify({
  error: { message: "Invalid value for temperature: must be <= 2", type: "invalid_request_error" },
});

function makeRoute({ channelId, modelId, channelName, alias = "target" }) {
  return {
    model: { id: modelId, alias, real_model: `m-${modelId}`, quota_mode: "none", max_concurrency: 0 },
    channel: { id: channelId, name: channelName, max_concurrency: 0, base_url: "https://upstream.invalid" },
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
      // 关键：注入真实实现，而不是 stub
      shouldRetryUpstreamStatus,
    },
  };
}

async function run({ routes, fetchImpl, maxRouteAttempts = 3 }) {
  const h = makeDeps({ routes, fetchImpl });
  const result = await requestUpstreamWithFallback({
    resolvedAlias: "target",
    inboundProtocol: "chat_completions",
    maxRouteAttempts,
    sameChannelRetry: false,
    requestSignal: new AbortController().signal,
    inboundHeaders: new Headers(),
    startedAt: Date.now(),
    estimatedTokens: 1,
    buildRequestBody: () => ({ model: "x" }),
    deps: h.deps,
  });
  return { result, attempted: h.attempted };
}

const routes = [
  makeRoute({ channelId: 7, modelId: 101, channelName: "high-weight" }),
  makeRoute({ channelId: 8, modelId: 102, channelName: "low-weight" }),
];

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${name}  (${a})`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}: got ${a}, want ${e}`);
    fail++;
  }
};

console.log("=== 场景 A：高权重渠道返回 400 额度耗尽 -> 应换到低权重渠道 ===");
{
  const { result, attempted } = await run({
    routes,
    fetchImpl: (route) =>
      route.channel.id === 7
        ? new Response(CREDIT_BODY, { status: 400, headers: { "content-type": "application/json" } })
        : new Response("ok", { status: 200 }),
  });
  check("两次上游请求（先 7 后 8）", attempted, [7, 8]);
  check("最终命中低权重渠道 8", result.ok === true ? result.route.channel.id : null, 8);
  check("响应状态为 200", result.ok === true ? result.upstream.status : null, 200);
}

console.log("\n=== 场景 B：同样的 400 但体是参数错误 -> 不换渠道，直接返回 400 ===");
{
  const { result, attempted } = await run({
    routes,
    fetchImpl: () => new Response(PARAM_BODY, { status: 400, headers: { "content-type": "application/json" } }),
  });
  check("只打了一次上游（渠道 7）", attempted, [7]);
  check("返回给客户端的是 400", result.ok === true ? result.upstream.status : null, 400);
  check("停在首选渠道 7", result.ok === true ? result.route.channel.id : null, 7);
}

console.log("\n=== 场景 C：换渠道后仍取到原响应体（clone 预读不能吃掉 body） ===");
{
  // 渠道 7 额度耗尽 -> 换到渠道 8；渠道 8 返回 200 且带 body，验证 body 未被预读消耗
  const { result } = await run({
    routes,
    fetchImpl: (route) =>
      route.channel.id === 7
        ? new Response(CREDIT_BODY, { status: 400, headers: { "content-type": "application/json" } })
        : new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }),
  });
  const text = await result.upstream.text();
  check("换渠道后 body 完整可读", text, '{"ok":true}');
}

console.log("\n=== 场景 C2：候选耗尽时返回失败结果，但仍保留最后一次上游状态 ===");
{
  const { result } = await run({
    routes,
    maxRouteAttempts: 3,
    fetchImpl: () => new Response(CREDIT_BODY, { status: 400, headers: { "content-type": "application/json" } }),
  });
  check("候选耗尽 -> ok=false", result.ok, false);
  check("保留了最后一次上游状态码", result.lastUpstreamStatus ?? null, 400);
}

console.log("\n=== 场景 D：两个渠道都额度耗尽 -> 两次尝试都被记录，最终失败 ===");
{
  const { result, attempted } = await run({
    routes,
    maxRouteAttempts: 3,
    fetchImpl: () => new Response(CREDIT_BODY, { status: 400, headers: { "content-type": "application/json" } }),
  });
  check("打过两个渠道后停止", attempted, [7, 8]);
  check("两个渠道都算真实尝试", result.attemptedChannels?.length ?? null, 2);
  check("最终失败并保留 400", [result.ok, result.lastUpstreamStatus ?? null], [false, 400]);
}

console.log("\n=== 场景 E：额度耗尽但仍受「最大路由尝试次数」约束 ===");
{
  const { attempted } = await run({
    routes,
    maxRouteAttempts: 1,
    fetchImpl: () => new Response(CREDIT_BODY, { status: 400, headers: { "content-type": "application/json" } }),
  });
  check("预算为 1 时只打一次", attempted, [7]);
}

console.log("\n=== 场景 F：超大 4xx 响应体只预读前缀（不把整条流读完） ===");
{
  // 关键词在最前面，后面接 4MB 填充。若实现是把整个 body 读进内存再切片，
  // peek 会一直读到流结束；正确实现应在命中前缀后主动 cancel。
  const FILLER = 4 * 1024 * 1024;
  const bigBody = CREDIT_BODY + "x".repeat(FILLER);
  let deliveredBytes = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      const chunk = new TextEncoder().encode(bigBody);
      const step = 64 * 1024;
      let offset = 0;
      const push = () => {
        if (cancelled) return;
        if (offset >= chunk.length) {
          try { controller.close(); } catch { /* noop */ }
          return;
        }
        controller.enqueue(chunk.subarray(offset, offset + step));
        deliveredBytes += Math.min(step, chunk.length - offset);
        offset += step;
      };
      push();
      this._push = push;
    },
    pull() { this._push?.(); },
    cancel() { cancelled = true; },
  });

  const { result, attempted } = await run({
    routes,
    fetchImpl: (route) =>
      route.channel.id === 7
        ? new Response(stream, { status: 400, headers: { "content-type": "application/json" } })
        : new Response("ok", { status: 200 }),
  });
  check("大响应体仍触发换渠道", attempted, [7, 8]);
  check("最终命中渠道 8", result.ok === true ? result.route.channel.id : null, 8);
  const deliveredMb = deliveredBytes / 1024 / 1024;
  console.log(`  INFO  预读期间实际交付 ${deliveredMb.toFixed(2)} MB（总量 ${(FILLER / 1024 / 1024).toFixed(2)} MB），cancelled=${cancelled}`);
  // 硬阈值：只读前缀的话远小于 1MB；若实现退化成读完整条流则必然超过。
  // 注意这里不能断言底层 source 的 cancel 回调：peek 取消的是 clone 出来的分支，
  // 规范允许原分支继续存活（原 body 仍需可读），因此 cancelled 可能为 false。
  check("只读前缀（交付量 < 1MB）", deliveredBytes < 1024 * 1024, true);
}

console.log("\n=== 场景 H：上游 header 秒回但 body 挂住时，预读不能拖住请求 ===");
{
  // proxy 的超时在 headers 到达时就 clearTimeout 了，之后 body 挂住不再受保护。
  // peek 必须有自己的上界，否则一个「400 + body 慢滴流」的上游能拖住整个请求。
  const started = Date.now();
  const { result, attempted } = await run({
    routes,
    fetchImpl: (route) =>
      route.channel.id === 7
        ? new Response(
            new ReadableStream({
              start(c) {
                // 先给出关键词，然后永远不再推数据、也不 close
                c.enqueue(new TextEncoder().encode(CREDIT_BODY));
              },
              pull() {
                return new Promise(() => {});
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          )
        : new Response("ok", { status: 200 }),
  });
  const elapsed = Date.now() - started;
  console.log(`  INFO  挂住 body 的请求耗时 ${elapsed}ms`);
  check("已读到的关键词仍触发换渠道", attempted, [7, 8]);
  check("最终命中渠道 8", result.ok === true ? result.route.channel.id : null, 8);
  check("耗时受预读超时约束（< 10s）", elapsed < 10_000, true);
}

console.log("\n=== 场景 G：单个巨大 chunk 也不能把整块读进内存 ===");
{
  // 有的上游一口气推 4MB 单块。若实现是「先 decode 整块再判长度」，限制就只约束了
  // 保留量、没约束工作量（实测会累积 4194325 个字符）。这里断言仍能命中关键词，
  // 且行为与分块推送一致。
  const big = new TextEncoder().encode(CREDIT_BODY + "x".repeat(4 * 1024 * 1024));
  const { result, attempted } = await run({
    routes,
    fetchImpl: (route) =>
      route.channel.id === 7
        ? new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(big);
                c.close();
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          )
        : new Response("ok", { status: 200 }),
  });
  check("单块大响应体也触发换渠道", attempted, [7, 8]);
  check("最终命中渠道 8", result.ok === true ? result.route.channel.id : null, 8);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);

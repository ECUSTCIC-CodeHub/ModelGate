// 候选遍历回归测试：直接 import 交付实现 lib/gateway/upstream-routing.ts 的 requestUpstreamWithFallback，
// 通过 deps 注入 stub 依赖（选路 / 渠道配额 / 模型配额 / 并发获取 / 上游请求），断言真实控制流的行为。
// 运行：node --experimental-transform-types --loader ./scripts/verify-upstream-candidate-loop-loader.mjs scripts/verify-upstream-candidate-loop.mjs
// （必须用 --loader：--import 在入口模块解析之后才注册钩子，入口自身的 @/ 导入会绕过钩子）
//
// 覆盖的核心场景（另含模型级排除不连坐、上界不误伤健康候选、上界可诊断、429 换渠道、
// 精确别名回退 * 等边界）：
//   1) 所有候选的预检都失败（渠道配额 / 并发 / 熔断）
//   2) 同渠道多模型实例 + 模型配额不足
//   3) 上界不误伤健康候选（上界只按实际访问候选计数，不与重试预算抢退出条件）
//
// 另有两个用例直接驱动 createCandidateQueue 本身，用「不自行应用排除集」的 load 桩把队列的
// 内存过滤与脏标记纳入断言范围：整条链路的 listModelRoutes 桩会自行按排除集过滤，会掩盖
// takeNext 的过滤与 consumeChannel 的 dirty 标记（实测：把这两处分别变异后旧用例仍全绿）。
import assert from "node:assert/strict";
import { requestUpstreamWithFallback, MAX_CANDIDATE_VISITS } from "@/lib/gateway/upstream-routing";
import { createCandidateQueue } from "@/lib/gateway/candidate-queue";

function makeRoute({ channelId, modelId, channelName, alias = "target", realModel = `m-${modelId}`, quotaMode = "none" }) {
  return {
    model: {
      id: modelId,
      alias,
      real_model: realModel,
      quota_mode: quotaMode,
      max_concurrency: 0,
    },
    channel: {
      id: channelId,
      name: channelName,
      max_concurrency: 0,
      base_url: "https://upstream.invalid",
    },
    effective_upstream_protocol: "chat_completions",
  };
}

// 记录选路查询次数，验证「全量候选 + 内存过滤」没有退化成每候选一次查询
function makeDeps({ allRoutes, precheck, fetchImpl }) {
  const attempted = [];
  const calls = { list: 0, fetch: 0 };
  return {
    calls,
    attempted,
    deps: {
      // 忠实复刻 router.ts 的语义：先按精确别名查，无候选才回退到字面 alias 为 "*" 的行；
      // excludeChannelIds / excludeModelIds 都在候选过滤阶段生效。
      listModelRoutes: async (alias, options) => {
        calls.list += 1;
        const excludedChannels = new Set(options?.excludeChannelIds ?? []);
        const excludedModels = new Set(options?.excludeModelIds ?? []);
        const accepted = (r) => !excludedChannels.has(r.channel.id) && !excludedModels.has(r.model.id);
        const exact = allRoutes.filter((r) => r.model.alias === alias).filter(accepted);
        if (exact.length > 0) return exact;
        return allRoutes.filter((r) => r.model.alias === "*").filter(accepted);
      },
      checkChannelQuota: async (channelId) => {
        const verdict = precheck({ channelId });
        if (verdict === "channel_quota") return { ok: false, reason: `渠道 ${channelId} 配额已用尽` };
        return { ok: true, quota: null };
      },
      checkModelQuota: async (modelId) => {
        const verdict = precheck({ modelId });
        if (verdict === "model_quota") return { ok: false, reason: `模型 ${modelId} 配额已用尽` };
        return { ok: true, quota: { limit: null, used: 0, remaining: null } };
      },
      acquireChannel: (key) => {
        const channelId = Number(key.slice(0, key.indexOf(":")));
        const verdict = precheck({ channelId });
        if (verdict === "circuit_open") return { ok: false, reason: "circuit_open" };
        if (verdict === "queue_full") return { ok: false, reason: "queue_full" };
        return {
          ok: true,
          lease: { key, complete() {}, abandon() {} },
        };
      },
      fetchUpstreamRequest: async (route) => {
        calls.fetch += 1;
        attempted.push(route.channel.id);
        return fetchImpl(route);
      },
      // 桩必须与真实实现同签名：第二参是生效的状态码列表，漏掉就会掩盖「渠道配置未生效」这类回归
      shouldRetryUpstreamStatus: (status, codes) => {
        if (status >= 500) return true;
        const configured = codes && codes.length > 0 ? codes : [401, 402, 403, 429];
        return configured.includes(status);
      },
    },
  };
}

async function run({ alias = "target", routes, precheck, fetchImpl = () => new Response("ok", { status: 200 }), maxRouteAttempts = 3, sameChannelRetry = false }) {
  const harness = makeDeps({ allRoutes: routes, precheck, fetchImpl });
  const result = await requestUpstreamWithFallback({
    resolvedAlias: alias,
    inboundProtocol: "chat_completions",
    maxRouteAttempts,
    sameChannelRetry,
    requestSignal: new AbortController().signal,
    inboundHeaders: new Headers(),
    startedAt: Date.now(),
    estimatedTokens: 1,
    buildRequestBody: () => ({ model: "x" }),
    deps: harness.deps,
  });
  return { result, attempted: harness.attempted, calls: harness.calls };
}

// 场景 1：所有候选的预检都失败（渠道配额 / 并发 / 熔断）
{
  const routes = [
    makeRoute({ channelId: 7, modelId: 101, channelName: "high-weight" }),
    makeRoute({ channelId: 8, modelId: 102, channelName: "low-weight" }),
  ];
  const { result, attempted, calls } = await run({ routes, precheck: () => "channel_quota" });
  assert.equal(result.ok, false, "预检全失败应返回失败");
  assert.deepEqual(attempted, [], "没有任何渠道真正打到上游");
  assert.deepEqual(result.attemptedChannels, [], "route_attempts 口径应为空");
  assert.deepEqual(result.skippedChannelNames, ["high-weight", "low-weight"], "两条渠道都应记为预检跳过");
  assert.match(result.quotaReason ?? "", /配额已用尽/, "失败原因应为可诊断的渠道配额提示");
  // 渠道级排除：首次拉取 + 每次渠道被消费后缓冲耗尽时重查 + 末尾确认 = 候选数 + 常数级，不出现二次方放大
  assert.ok(calls.list <= routes.length + 2, `选路查询次数不应随候选数放大，实际 ${calls.list} 次`);
  console.log("场景1 所有候选预检失败: OK", JSON.stringify({ skipped: result.skippedChannelNames, quotaReason: result.quotaReason, listCalls: calls.list }));
}

// 场景 2：同渠道多模型实例 + 模型配额不足
{
  const routes = [
    makeRoute({ channelId: 7, modelId: 101, channelName: "only-channel", quotaMode: "independent" }),
    makeRoute({ channelId: 7, modelId: 102, channelName: "only-channel", quotaMode: "independent" }),
    makeRoute({ channelId: 7, modelId: 103, channelName: "only-channel", quotaMode: "independent" }),
  ];
  const { result, attempted, calls } = await run({ routes, precheck: () => "model_quota" });
  assert.equal(result.ok, false, "模型配额全不足应返回失败");
  assert.deepEqual(attempted, [], "模型配额不足不应产生上游请求");
  assert.deepEqual(result.skippedChannelNames, ["only-channel"], "同渠道只记录一次渠道名");
  assert.match(result.quotaReason ?? "", /模型 103 配额已用尽/, "失败原因应为最后一次模型配额提示");
  // 模型级排除在内存过滤：首次拉取 + 缓冲耗尽后确认重查 = 2 次，不随模型实例数放大
  assert.equal(calls.list, 2, `模型级排除应在内存过滤，选路次数不随模型实例数放大；实际 ${calls.list} 次`);
  console.log("场景2 同渠道多模型+模型配额不足: OK", JSON.stringify({ skipped: result.skippedChannelNames, listCalls: calls.list }));
}

// 场景 2b：同渠道多模型实例中只有一个模型配额不足，其余模型应被真正使用
{
  const routes = [
    makeRoute({ channelId: 7, modelId: 101, channelName: "shared", quotaMode: "independent" }),
    makeRoute({ channelId: 7, modelId: 102, channelName: "shared", quotaMode: "independent" }),
  ];
  const { result, attempted } = await run({
    routes,
    precheck: ({ modelId }) => (modelId === 101 ? "model_quota" : "ok"),
  });
  assert.equal(result.ok, true, "同渠道其它模型实例应可用");
  assert.deepEqual(attempted, [7], "渠道 7 应被真正使用一次");
  assert.equal(result.route.model.id, 102, "落点应为配额充足的模型实例");
  console.log("场景2b 同渠道模型级排除不连坐: OK");
}

// 场景 3：高权重渠道预检失败 -> 低权重渠道被真正使用（本 Issue 的正解）
{
  const routes = [
    makeRoute({ channelId: 7, modelId: 101, channelName: "high-weight" }),
    makeRoute({ channelId: 8, modelId: 102, channelName: "low-weight" }),
  ];
  const { result, attempted } = await run({
    routes,
    precheck: ({ channelId }) => (channelId === 7 ? "circuit_open" : "ok"),
  });
  assert.equal(result.ok, true, "低权重渠道应被使用");
  assert.deepEqual(attempted, [8], "只有低权重渠道真正打到上游");
  assert.deepEqual(result.attemptedChannels, [8], "route_attempts 只统计真正请求的渠道");
  assert.deepEqual(result.skippedChannelNames, ["high-weight"], "高权重渠道记为预检跳过");
  console.log("场景3 低权重渠道被触及: OK");
}

// 场景 4：上界不误伤健康候选（把健康候选顶到上界允许的最后一个访问位）
// 候选数取 MAX_CANDIDATE_VISITS + 1（实测该值恰为可行上界：正确实现 P=513 通过、514 失败），
// 最后一个候选健康：上界按「实际取到候选」计数时，第 maxVisits 个候选仍会被取出并交回调用方
// （上界不清空已取候选），因此健康候选恰好落在允许的最后一个访问位、必须被真正使用。
// 守门作用：上界若退化成「按循环迭代数计数」（旧缺陷），迭代数会先于候选数触顶并提前放弃，
// 本用例立刻变红（实测：正确实现通过，迭代计数缺陷在该 P 下失败）；原取值 P=60 因远离阈值
// 对缺陷无感。
// 注意两点：
//   1) 不能把 P 抬到常量之上（例如 MAX_CANDIDATE_VISITS * 2）：那样健康候选落在上界之外，
//      正确实现也会失败，反而失去意义——真正该被钉住的是「边界候选被返回而非丢弃」；
//   2) P 随常量联动，本用例只钉「按候选计数的语义」，不钉常量数值本身（常量是可调旋钮）。
{
  const P = MAX_CANDIDATE_VISITS + 1;
  const routes = Array.from({ length: P }, (_, i) =>
    makeRoute({ channelId: 100 + i, modelId: 1000 + i, channelName: `c${100 + i}` }),
  );
  const { result, attempted, calls } = await run({
    routes,
    precheck: ({ channelId }) => (channelId === 100 + P - 1 ? "ok" : "channel_quota"),
  });
  assert.equal(result.ok, true, "P 很大时仍应走到健康候选");
  assert.deepEqual(attempted, [100 + P - 1], "健康候选应被真正使用");
  assert.equal(result.attemptedChannels.length, 1);
  assert.equal(result.skippedChannelNames.length, P - 1, "其余候选应全部记为预检跳过");
  assert.ok(calls.list <= P, `选路查询次数（${calls.list}）不应超过候选数（${P}）的量级`);
  console.log("场景4 P 很大不误伤健康候选: OK", JSON.stringify({ P, visitedCap: MAX_CANDIDATE_VISITS, listCalls: calls.list }));
}

// 场景 5：上界触发时既保留真实原因、又附注上界信息，不静默退出也不覆盖原因
{
  const routes = Array.from({ length: MAX_CANDIDATE_VISITS + 10 }, (_, i) =>
    makeRoute({ channelId: 200 + i, modelId: 2000 + i, channelName: `c${200 + i}` }),
  );
  const { result, attempted } = await run({ routes, precheck: () => "channel_quota" });
  assert.equal(result.ok, false);
  assert.deepEqual(attempted, [], "上界触发时不应误报已打到上游");
  assert.match(result.quotaReason ?? "", /候选遍历达到上界/, "上界触发应留下可诊断标注");
  assert.match(result.quotaReason ?? "", /配额已用尽/, "上界附注不应覆盖真实预检原因");
  // 上界只在「真的取到候选」时计数：第 MAX+1 个候选仍被处理并计入 skipped，不丢候选
  assert.equal(result.skippedChannelNames.length, MAX_CANDIDATE_VISITS + 1, "上界边界候选不应被丢弃");
  console.log("场景5 上界触发可诊断且不覆盖原因: OK", JSON.stringify({ skipped: result.skippedChannelNames.length, quotaReason: result.quotaReason }));
}

// 场景 5b：上界触发后仍允许 sameChannelRetry（上界不得抢重试预算的退出条件）
{
  // 首个候选真正打到上游但持续 500（建立 lastRequestedRoute 并触发换渠道），
  // 其余候选渠道配额耗尽；候选总数超过上界，验证上界触发不会吃掉 sameChannelRetry。
  const routes = Array.from({ length: MAX_CANDIDATE_VISITS + 10 }, (_, i) =>
    makeRoute({ channelId: 300 + i, modelId: 3000 + i, channelName: `c${300 + i}` }),
  );
  const retryBudget = 4;
  const { calls } = await run({
    routes,
    precheck: ({ channelId }) => (channelId === 300 ? "ok" : "channel_quota"),
    fetchImpl: () => new Response("boom", { status: 500 }),
    sameChannelRetry: true,
    maxRouteAttempts: retryBudget,
  });
  assert.equal(calls.fetch, retryBudget, `上界触发后同渠道重试应跑满预算 ${retryBudget}，实际 fetch ${calls.fetch} 次`);
  console.log("场景5b 上界不抢重试预算退出权: OK", JSON.stringify({ fetch: calls.fetch }));
}

// 场景 6：上游 429 换渠道（校验 shouldRetryUpstreamStatus 路径与重试预算交互）
{
  const routes = [
    makeRoute({ channelId: 7, modelId: 101, channelName: "c7" }),
    makeRoute({ channelId: 8, modelId: 102, channelName: "c8" }),
  ];
  const { result, attempted } = await run({
    routes,
    precheck: () => "ok",
    maxRouteAttempts: 3,
    fetchImpl: (route) => new Response(route.channel.id === 7 ? "rate limited" : "ok", {
      status: route.channel.id === 7 ? 429 : 200,
    }),
  });
  assert.equal(result.ok, true, "429 后应换到渠道 8");
  assert.deepEqual(attempted, [7, 8], "两个渠道都应真正打到上游");
  assert.equal(result.route.channel.id, 8);
  console.log("场景6 上游 429 换渠道: OK");
}

// 场景 7：精确别名候选被模型级排除吃光后，按 router 语义回退到 "*" 别名候选
{
  const routes = [
    makeRoute({ channelId: 7, modelId: 101, channelName: "exact-a", quotaMode: "independent" }),
    makeRoute({ channelId: 7, modelId: 102, channelName: "exact-a", quotaMode: "independent" }),
    makeRoute({ channelId: 9, modelId: 201, channelName: "wildcard", alias: "*" }),
  ];
  const { result, attempted, calls } = await run({
    routes,
    precheck: ({ modelId }) => (modelId === 201 ? "ok" : "model_quota"),
  });
  assert.equal(result.ok, true, "精确别名候选耗尽后应回退到 * 别名候选");
  assert.deepEqual(attempted, [9], "落点应为 * 别名的健康候选");
  assert.equal(result.route.model.id, 201);
  assert.ok(calls.list >= 2, "回退 * 别名需要重查候选");
  console.log("场景7 精确别名耗尽后回退 * 别名: OK", JSON.stringify({ listCalls: calls.list }));
}

// 场景 8：直接驱动候选队列，验证 takeNext 的内存过滤由队列自身负责
// load 桩不自行应用排除集，每次都返回同一批候选：若 takeNext 忽略 excludedModelIds /
// consumedChannelIds，就会把已被排除的候选重新交出去。
{
  const routes = [
    makeRoute({ channelId: 7, modelId: 101, channelName: "c7" }),
    makeRoute({ channelId: 7, modelId: 102, channelName: "c7" }),
    makeRoute({ channelId: 8, modelId: 201, channelName: "c8" }),
  ];
  let loadCalls = 0;
  const queue = createCandidateQueue({
    load: async () => {
      loadCalls += 1;
      // 返回副本：否则队列内部 shift() 会原地掏空同一数组，让「末尾重查确认耗尽」靠副作用成立
      return [...routes];
    },
  });
  const first = await queue.shift();
  assert.equal(first.type, "candidate");
  assert.equal(first.route.model.id, 101, "首个候选应为 101");
  queue.excludeModel(101);
  const second = await queue.shift();
  assert.equal(second.type, "candidate");
  assert.equal(second.route.model.id, 102, "被排除的模型实例不应再被取出");
  queue.excludeModel(102);
  queue.excludeModel(201);
  const third = await queue.shift();
  assert.equal(third.type, "exhausted", "全部模型实例被排除后应耗尽，不得重复交出候选");
  // 模型级排除在内存过滤：取出 101/102 期间只有首次那 1 次拉取；
  // 末尾缓冲被过滤空且排除集已变，才补 1 次重查确认耗尽，不做每候选一查。
  assert.equal(loadCalls, 2, `模型级排除应在内存过滤，仅末尾确认耗尽时重查一次，实际 ${loadCalls} 次`);
  console.log("场景8 队列自身过滤被排除候选: OK", JSON.stringify({ loadCalls }));
}

// 场景 9：consumeChannel 的脏标记必须触发重查，否则会漏掉「回退 * 别名」的新候选
// load 桩不自行应用排除集，但忠实复刻 router：精确别名候选被排除集合吃光后回退到 "*"；
// 回退只可能在重新查询时发生。缓冲里剩余候选被过滤空后，只有 dirty 才会触发这次重查。
{
  const exact = [
    makeRoute({ channelId: 7, modelId: 101, channelName: "c7" }),
    makeRoute({ channelId: 7, modelId: 102, channelName: "c7" }),
  ];
  const wildcard = [makeRoute({ channelId: 9, modelId: 201, channelName: "c9", alias: "*" })];
  const loadExclusions = [];
  let loadCalls = 0;
  const queue = createCandidateQueue({
    load: async ({ excludeChannelIds, excludeModelIds }) => {
      loadCalls += 1;
      loadExclusions.push({ excludeChannelIds: [...excludeChannelIds], excludeModelIds: [...excludeModelIds] });
      // filter 产新数组，天然免疫队列内部 shift() 的原地掏空，无需像场景 8 那样显式拷贝
      const usableExact = exact.filter(
        (r) => !excludeChannelIds.includes(r.channel.id) && !excludeModelIds.includes(r.model.id),
      );
      if (usableExact.length > 0) return usableExact;
      return wildcard.filter((r) => !excludeChannelIds.includes(r.channel.id));
    },
  });
  const first = await queue.shift();
  assert.equal(first.route.model.id, 101);
  queue.consumeChannel(7);
  const second = await queue.shift();
  assert.equal(second.type, "candidate", "整条渠道被消费后应重查候选");
  assert.equal(second.route.model.id, 201, "重查应命中回退的 * 别名候选");
  assert.deepEqual(loadExclusions[1].excludeChannelIds, [7], "重查必须带上被消费的渠道排除集");
  assert.equal(loadCalls, 2, "缓冲耗尽且排除集已变，应恰好重查一次");
  const third = await queue.shift();
  assert.equal(third.type, "exhausted", "重查后无可用候选应耗尽");
  console.log("场景9 消费渠道的脏标记触发重查: OK", JSON.stringify({ loadCalls, loadExclusions }));
}

console.log("\n上游候选遍历测试（真实 import 交付实现）全部通过");

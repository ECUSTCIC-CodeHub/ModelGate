// ESM 解析钩子：让运行时用例能在不依赖 Next 构建 / 数据库的情况下直接驱动
// lib/gateway/gateway-handler.ts 的 handleGatewayProtocolRequest。
//
// 动机：gateway-handler 的 4 个熔断计入点此前只有源码形态守卫（AST），
// 形态守卫看不见「调用点不改文本、只在判定前把 route.model.retry_status_codes
// 写回」这类写入式变异。要堵住它，必须真的执行到那些调用点。
//
// 本 loader 只做两件事：
//   1) 把 "@/..." 解析到仓库根目录（对齐 tsconfig 的 paths）；
//   2) 把会拉起 next / better-sqlite3 / 网络的模块替换为「由 globalThis.__HARNESS__ 驱动」
//      的可控桩。桩函数从控制对象取返回值，测试可在运行时改。
//
// 用法：
//   node --experimental-transform-types --loader ./scripts/verify-gateway-handler-circuit-loader.mjs \
//     scripts/verify-gateway-handler-circuit.mjs
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_PREFIX = pathToFileURL(ROOT + path.sep).href;

// 每个条目：模块相对路径 -> 该模块导出的桩源码。
// 桩一律从 globalThis.__HARNESS__ 读实现，未设置时抛出（避免静默返回 undefined 掩盖接线错误）。
const STUB_SOURCES = {
  "lib/core/db/index.ts": `
export const gatewayDb = {
  queryOne: async () => null,
  query: async () => [],
  execute: async () => ({ changes: 0 }),
};
`,
  "lib/core/settings.ts": `
export const getGatewaySettings = async () => h().settings;
`,
  "lib/auth/api-key-auth.ts": `
export const checkApiKeyAuth = async () => h().authResult;
`,
  "lib/gateway/channel-access.ts": `
export const getUserAllowedChannelIds = async () => h().allowedChannelIds ?? null;
`,
  "lib/gateway/chat-log.ts": `
export const insertChatLog = (row) => { h().chatLogs.push(row); };
export const withSubstitutionNote = (metadata) => metadata;
`,
  "lib/gateway/router.ts": `
export const listModelRoutes = async (alias, options) => {
  const harness = h();
  const exC = new Set(options?.excludeChannelIds ?? []);
  const routes = harness.routes.filter((r) => !exC.has(r.channel.id));
  return routes;
};
export const selectModelRoute = async () => h().routes[0];
export const findUaDenyMatchForAlias = () => null;
export const findVisionFallbackRoute = () => null;
export const findQuotaFallbackRoute = () => null;
export const resolveModelFallbackAlias = async (alias) => alias;
`,
  "lib/gateway/model-access.ts": `
export const resolveAccessibleModelAlias = async (_user, alias) => ({ ok: true, alias });
`,
  "lib/gateway/channel-quota.ts": `
export const checkChannelQuota = async () => ({ ok: true, quota: null });
export const appendChannelQuotaHeaders = () => {};
`,
  "lib/gateway/model-quota.ts": `
export const checkModelQuota = async () => ({ ok: true, quota: { limit: null, used: 0, remaining: null } });
export const appendModelQuotaHeaders = () => {};
`,
  "lib/gateway/proxy.ts": `
export const buildUpstreamUrl = () => "https://upstream.invalid/v1/chat/completions";
export const fetchUpstreamRequest = async (route) => h().fetchImpl(route);
`,
  // channel-runtime 的 lease.complete 是熔断计入的唯一观测点，必须把 outcome 记进 harness。
  // 真实实现会读写模块级运行时状态，桩掉更利于断言隔离；导出面按真实模块补齐，
  // 避免 upstream-routing 等消费者因缺导出而加载失败。
  "lib/gateway/channel-runtime.ts": `
export function makeModelRuntimeKey(channelId, realModel) { return channelId + ":" + realModel; }
export function parseModelRuntimeKey(key) {
  const index = String(key).indexOf(":");
  return { channelId: Number(String(key).slice(0, index)), realModel: String(key).slice(index + 1) };
}
export class ChannelLease {
  constructor(runtimeKey) { this.runtimeKey = runtimeKey; this.released = false; }
  complete(result) {
    if (this.released) return;
    this.released = true;
    h().leaseOutcomes.push(result);
  }
  abandon() { this.released = true; }
}
export function acquireChannel(key) {
  return { ok: true, queued: false, lease: new ChannelLease(key) };
}
export function tryAcquireChannel(key) {
  return { ok: true, queued: false, lease: new ChannelLease(key) };
}
export function scoreChannel() { return 1; }
`,
  "lib/gateway/quota.ts": `
export const checkQuota = async () => ({ ok: true });
export const appendQuotaHeaders = () => {};
`,
  "lib/gateway/ratelimit.ts": `
export const checkUserRateLimit = async () => ({ ok: true });
`,
  "lib/gateway/usage-accounting.ts": `
export const addUsage = () => {};
`,
  "lib/services/redeem-codes.ts": `
export const findMatchingRedeemBalance = async () => null;
`,
  "lib/gateway/body-limit.ts": `
export const exceedsBodyLimit = () => false;
export const resolveBodyLimitBytes = async () => null;
`,
  "lib/core/request-body.ts": `
export const readJsonBodyCapped = async (request) => ({ ok: true, data: await request.json().catch(() => null) });
`,
  "lib/core/client-ip.ts": `
export const resolveClientIp = () => "127.0.0.1";
`,
};

function resolveAlias(specifier) {
  const base = path.join(ROOT, specifier.slice(2));
  // 同 tsconfig 的 bundler 解析：先补后缀，再看目录 index，目录本身不能直接当模块加载。
  const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base];
  return candidates.find((candidate) => existsSync(candidate)) ?? base;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    return nextResolve(pathToFileURL(resolveAlias(specifier)).href, context);
  }
  // 新版 Node 的 ESM 解析不开 extensionless 子路径，而 next 的 package exports 里
  // server 指向无后缀文件；显式补后缀，避免 lib/core/http.ts 加载失败。
  if (specifier === "next/server") {
    return nextResolve(pathToFileURL(path.join(ROOT, "node_modules/next/server.js")).href, context);
  }
  return nextResolve(specifier, context);
}

// 每个桩模块前置一个 harness 读取器：未安装 harness 或缺少所需键时显式抛错，
// 避免桩静默返回 undefined 让被测代码走错分支却「看似通过」。
const HARNESS_PRELUDE = `
const h = () => {
  const harness = globalThis.__HARNESS__;
  if (!harness) throw new Error("测试 harness 未安装：请先设置 globalThis.__HARNESS__");
  return harness;
};
`;

export function load(url, context, nextLoad) {
  if (url.startsWith(ROOT_PREFIX)) {
    const rel = url.slice(ROOT_PREFIX.length).split(path.sep).join("/");
    const source = STUB_SOURCES[rel];
    if (source) {
      return { format: "module", shortCircuit: true, source: HARNESS_PRELUDE + source };
    }
  }
  return nextLoad(url, context);
}

// ESM 解析钩子：让 scripts/verify-upstream-candidate-loop.mjs 能在不依赖 Next 构建的情况下
// 直接 import lib/gateway/upstream-routing.ts。做两件事：
//   1) 把 "@/..." 解析到仓库根目录（对齐 tsconfig 的 paths）；
//   2) 只桩掉模块图里会拉起数据库驱动 / 网络的重依赖；channel-runtime 因需保真而整体加载
//      真实实现（其 acquireChannel 由 deps 注入覆盖，热路径不会走到真实单例状态）。
//
// 用法（必须用 --loader 而非 --import：--import 在入口模块解析之后才注册钩子，
// 入口自身的 "@/" 导入会绕过钩子；必须用 --experimental-transform-types 而非
// --experimental-strip-types：真实 channel-runtime.ts 用了 TS parameter property，
// strip-only 模式不支持）：
//   node --experimental-transform-types --loader ./scripts/verify-upstream-candidate-loop-loader.mjs \
//     scripts/verify-upstream-candidate-loop.mjs
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_PREFIX = pathToFileURL(ROOT + path.sep).href;

// 会间接拉起 next / better-sqlite3 / mysql2 / undici 的模块，按具名导出替换为占位。
// 占位只用于让模块图能加载；其中被热路径调用的导出（选路 / 配额 / 上游请求等）一律由
// 测试注入的 deps stub 覆盖，因此这些占位实现不会被执行。
const STUBBED_MODULES = {
  "lib/gateway/router.ts": ["listModelRoutes", "selectModelRoute"],
  "lib/gateway/channel-quota.ts": ["checkChannelQuota"],
  "lib/gateway/model-quota.ts": ["checkModelQuota"],
  "lib/gateway/proxy.ts": ["buildUpstreamUrl", "fetchUpstreamRequest"],
  "lib/gateway/upstream-error.ts": ["shouldRetryUpstreamStatus", "normalizeRetryStatusCodes"],
  "lib/core/settings.ts": ["getGatewaySettings"],
  "lib/core/db/index.ts": ["gatewayDb"],
};

// 逐个补充解析后缀，命中 tsconfig 的 bundler 解析行为
function resolveAlias(specifier) {
  const base = path.join(ROOT, specifier.slice(2));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? base;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    return nextResolve(pathToFileURL(resolveAlias(specifier)).href, context);
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url.startsWith(ROOT_PREFIX)) {
    const rel = url.slice(ROOT_PREFIX.length).split(path.sep).join("/");
    const names = STUBBED_MODULES[rel];
    if (names) {
      const source = names.map((name) => `export const ${name} = undefined;`).join("\n");
      return { format: "module", shortCircuit: true, source };
    }
  }
  return nextLoad(url, context);
}

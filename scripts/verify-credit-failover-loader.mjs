// 与 verify-upstream-candidate-loop-loader.mjs 相同，唯一区别是**不 stub**
// lib/gateway/upstream-error.ts —— 端到端用例要驱动真实的 shouldRetryUpstreamStatus
// （按响应文本判定 4xx 额度耗尽），stub 掉就测不到新逻辑。
//
// 运行：
//   node --experimental-transform-types --loader ./scripts/verify-credit-failover-loader.mjs \
//     scripts/verify-upstream-credit-failover-e2e.mjs
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_PREFIX = pathToFileURL(ROOT + path.sep).href;

// 只保留真正会拉起 next / 数据库 / 网络的模块；upstream-error 故意不在此列。
const STUBBED_MODULES = {
  "lib/gateway/router.ts": ["listModelRoutes", "selectModelRoute"],
  "lib/gateway/channel-quota.ts": ["checkChannelQuota"],
  "lib/gateway/model-quota.ts": ["checkModelQuota"],
  "lib/gateway/proxy.ts": ["buildUpstreamUrl", "fetchUpstreamRequest"],
  "lib/core/settings.ts": ["getGatewaySettings"],
  "lib/core/db/index.ts": ["gatewayDb"],
};

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

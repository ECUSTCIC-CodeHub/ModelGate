// 渠道配额模式验证用 loader：只 stub 数据库入口，让 checkChannelQuota 读到可控的行，
// 其余模块（channel-quota / quota-mode / period-cycles / features）走真实实现。
//
// 运行：
//   node --loader ./scripts/verify-channel-quota-mode-loader.mjs scripts/verify-channel-quota-mode.mjs
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_PREFIX = pathToFileURL(ROOT + path.sep).href;

// 注意键必须是实际解析到的文件（@/lib/core/db 解析成 lib/core/db.ts，不是 db/index.ts）。
const STUB_SOURCES = {
  "lib/core/db.ts": [
    "export const gatewayDb = (globalThis.__channelQuotaStub ??= { queryOne: async () => null });",
    "export const ensureDbReady = async () => gatewayDb;",
  ].join("\n"),
};

function resolveAlias(specifier) {
  const base = path.join(ROOT, specifier.slice(2));
  // 先试带扩展名的文件：@/lib/core/db 对应的 lib/core/db 目录与 db.ts 同名，
  // 目录排在前面会被解析成目录导入（ERR_UNSUPPORTED_DIR_IMPORT）。
  const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base];
  return candidates.find((candidate) => existsSync(candidate)) ?? base;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    return nextResolve(pathToFileURL(resolveAlias(specifier)).href, context);
  }
  // 交付代码里有 "./period-cycles" 这类无扩展名相对导入，Node 默认不补 .ts。
  if (specifier.startsWith(".") && context.parentURL) {
    const abs = fileURLToPath(new URL(specifier, context.parentURL).href);
    const candidates = [`${abs}.ts`, `${abs}.tsx`, path.join(abs, "index.ts"), abs];
    const hit = candidates.find((candidate) => existsSync(candidate));
    if (hit) return nextResolve(pathToFileURL(hit).href, context);
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url.startsWith(ROOT_PREFIX)) {
    const rel = url.slice(ROOT_PREFIX.length).split(path.sep).join("/");
    const source = STUB_SOURCES[rel];
    if (source) {
      return { format: "module", shortCircuit: true, source };
    }
  }
  return nextLoad(url, context);
}

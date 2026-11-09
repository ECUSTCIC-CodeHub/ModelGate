// 解析钩子：让 verify-opencode-session-passthrough.mjs 能直接 import lib/gateway/proxy.ts。
// 用法：
//   node --experimental-transform-types --loader ./scripts/verify-opencode-session-passthrough-loader.mjs \
//     scripts/verify-opencode-session-passthrough.mjs
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveTo(url) {
  if (url.endsWith(".ts") || url.endsWith(".mjs") || url.endsWith(".js") || url.endsWith(".json")) return url;
  for (const suffix of [".ts", "/index.ts", ".mjs", ".js"]) {
    if (existsSync(fileURLToPath(url + suffix))) return url + suffix;
  }
  return url;
}

// proxy.ts 只用到 jsonError，把 next/server 桩成最小 Response 工厂，避免装整个 Next
const STUBS = {
  undici: `export const fetch = (url, init) => globalThis.fetch(url, init);
export class Agent {}
export class ProxyAgent {}`,
  "next/server": `export class NextResponse extends Response {
  static json(body, init) {
    return new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json" } });
  }
}`,
};

export async function resolve(specifier, context, nextResolve) {
  if (STUBS[specifier]) {
    return nextResolve(`data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, context);
  }
  if (specifier.startsWith("@/")) {
    return nextResolve(resolveTo(pathToFileURL(path.join(ROOT, specifier.slice(2))).href), context);
  }
  if (specifier.startsWith(".") && context.parentURL) {
    return nextResolve(resolveTo(new URL(specifier, context.parentURL).href), context);
  }
  return nextResolve(specifier, context);
}

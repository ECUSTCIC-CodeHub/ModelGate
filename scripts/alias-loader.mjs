// 最小 loader：把 "@/..." 解析到仓库根目录（对齐 tsconfig 的 paths），
// 并按 TS 习惯补上 .ts 扩展名；不 stub 任何模块，被测模块是真实实现。
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function candidateUrls(specifier, parentUrl) {
  const base = specifier.startsWith("@/")
    ? pathToFileURL(path.join(ROOT, specifier.slice(2))).href
    : specifier.startsWith(".") && parentUrl
      ? new URL(specifier, parentUrl).href
      : null;
  return base;
}

export async function resolve(specifier, context, nextResolve) {
  const base = candidateUrls(specifier, context.parentURL);
  if (base) {
    // 已经是可用路径（带扩展名）就直接用
    if (base.endsWith(".ts") || base.endsWith(".mjs") || base.endsWith(".js") || base.endsWith(".json")) {
      return nextResolve(base, context);
    }
    // 依次尝试 .ts / /index.ts
    for (const suffix of [".ts", "/index.ts", ".mjs", ".js"]) {
      const url = base + suffix;
      if (existsSync(fileURLToPath(url))) {
        return nextResolve(url, context);
      }
    }
  }
  return nextResolve(specifier, context);
}

// verify-auth-scope.mjs 的模块桩注册器（通过 node:module 的 register 生效）。
//
// 目的：不装依赖、不连数据库，直接跑真实的 guards 与鉴权分支。
// 桩分两类：裸模块名（依赖包）与仓库内相对路径，分开存放，避免靠文件后缀反推。
//
// 桩掉的东西只有三处：
//   - next/server：jsonError / jsonOk 用到的 NextResponse
//   - next：auth.ts 的 `import { cookies } from "next"`（本脚本不走 Cookie Store）
//   - lib/core/db：假用户表与假密钥表，web 会话与 API Key 指向同一个启用管理员
// bcryptjs / jsonwebtoken 只服务于密码与令牌签发，本脚本不覆盖那两条路径，同样给最小实现。
// 这样脚本在没有 node_modules 的 CI 镜像里也能跑。
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_PREFIX = pathToFileURL(ROOT + path.sep).href;

const MODULE_STUBS = {
  bcryptjs: `export default { hash: async () => "$2b$10$stub", compare: async () => false };`,
  jsonwebtoken: `function parts(token) {
  const list = String(token).split(".");
  if (list.length !== 3) throw new Error("invalid token");
  return list;
}
export default {
  sign(payload, secret) {
    return ["hs256", secret, Buffer.from(JSON.stringify(payload)).toString("base64url")].join(".");
  },
  verify(token, secret) {
    const [, signSecret, body] = parts(token);
    if (signSecret !== secret) throw new Error("invalid token");
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  },
};`,
  next: `export const cookies = async () => ({ get: () => undefined });`,
  "next/server": `export class NextResponse extends Response {
  static json(body, init) {
    return new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  }
}`,
};

const FILE_STUBS = {
  "lib/core/db.ts": `const user = { id: 1, username: "tester", role: "admin", group_id: null, token_version: 1, enabled: 1, deleted_at: null };
export const gatewayDb = {
  queryOne: async (sql, params) => {
    const text = String(sql);
    if (text.includes("FROM users")) return user;
    if (text.includes("FROM \`keys\`")) {
      return params?.[0] === "sk-gw-test" ? { id: 10, key: "sk-gw-test", name: "test", user_id: 1, enabled: 1, deleted_at: null } : null;
    }
    return null;
  },
  query: async () => [],
  execute: async () => ({ lastInsertRowid: 1, changes: 1 }),
};
export const ensureDbReady = async () => gatewayDb;
`,
};

function resolveAlias(specifier) {
  const base = path.join(ROOT, specifier.slice(2));
  // @/lib/core/db 与 lib/core/db 目录同名，带扩展名的文件优先
  const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base];
  return candidates.find((candidate) => existsSync(candidate)) ?? base;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier in MODULE_STUBS) {
    return { url: `data:text/javascript,${encodeURIComponent(MODULE_STUBS[specifier])}`, shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    return nextResolve(pathToFileURL(resolveAlias(specifier)).href, context);
  }
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
    const source = FILE_STUBS[rel];
    if (source) return { format: "module", shortCircuit: true, source };
  }
  return nextLoad(url, context);
}

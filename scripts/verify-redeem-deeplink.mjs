// 验证扫码直达链路（t1 契约 C31，D1–D4）。
// 真实链路：临时 SQLite 库 + 真实页面导出函数 + 真实 /r 路由 + 真实 user/redeem 路由。
// 运行：node scripts/verify-redeem-deeplink.mjs（脚本会自举 --experimental-transform-types 并自注册别名/TSX loader）
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";

if (!process.execArgv.some((arg) => arg.includes("transform-types"))) {
  const child = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", import.meta.filename],
    { stdio: "inherit", env: process.env },
  );
  process.exit(child.status ?? 1);
}

process.env.MODELGATE_EDITION = "full";
process.env.NEXT_PUBLIC_MODELGATE_EDITION = "full";
process.env.DB_DRIVER = "sqlite";
process.env.JWT_ACCESS_SECRET = "verify-access-secret";
process.env.JWT_REFRESH_SECRET = "verify-refresh-secret";

const workspace = process.cwd();
process.env.__VERIFY_ROOT__ = workspace;
const sandbox = mkdtempSync(path.join(tmpdir(), "redeem-deeplink-verify-"));
process.chdir(sandbox);

// 自带 loader：@/ 别名、无扩展名相对导入补 .ts/.tsx、next/* 根路径入口，
// 并用仓库内的 TypeScript 把 .ts/.tsx 转成 ESM（Node 原生不认 TSX）。
const loaderSource = [
  "import { existsSync, readFileSync } from 'node:fs';",
  "import { fileURLToPath, pathToFileURL } from 'node:url';",
  "import path from 'node:path';",
  "const ROOT = path.resolve(process.env.__VERIFY_ROOT__);",
  "function inRoot(p) {",
  "  const rel = path.relative(ROOT, path.resolve(p));",
  "  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);",
  "}",
  "function firstExisting(base) {",
  "  const candidates = [base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx'), base];",
  "  return candidates.find((c) => existsSync(c));",
  "}",
  "export function resolve(specifier, context, nextResolve) {",
  "  if (specifier.startsWith('@/')) {",
  "    const hit = firstExisting(path.join(ROOT, specifier.slice(2)));",
  "    if (hit) return nextResolve(pathToFileURL(hit).href, context);",
  "  }",
  "  if (specifier.startsWith('.') && context.parentURL) {",
  "    const abs = fileURLToPath(new URL(specifier, context.parentURL).href);",
  "    const hit = firstExisting(abs);",
  "    if (hit) return nextResolve(pathToFileURL(hit).href, context);",
  "  }",
  "  if (specifier.startsWith('next/')) {",
  "    const candidate = path.join(ROOT, 'node_modules', 'next', specifier.slice('next/'.length) + '.js');",
  "    if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);",
  "  }",
  "  return nextResolve(specifier, context);",
  "}",
  "let tsPromise;",
  "function loadTs() {",
  "  tsPromise ??= import(pathToFileURL(path.join(ROOT, 'node_modules/typescript/lib/typescript.js')).href).then((m) => m.default ?? m);",
  "  return tsPromise;",
  "}",
  "export async function load(url, context, nextLoad) {",
  "  const pathname = url.startsWith('file:') ? fileURLToPath(url) : '';",
  "  if (pathname && (pathname.endsWith('.ts') || pathname.endsWith('.tsx')) && inRoot(pathname) && !pathname.includes('node_modules')) {",
  "    const ts = await loadTs();",
  "    const source = readFileSync(pathname, 'utf8');",
  "    const out = ts.transpileModule(source, {",
  "      compilerOptions: {",
  "        module: ts.ModuleKind.ESNext,",
  "        target: ts.ScriptTarget.ES2022,",
  "        jsx: ts.JsxEmit.ReactJSX,",
  "        moduleResolution: ts.ModuleResolutionKind.Bundler,",
  "        esModuleInterop: true,",
  "      },",
  "      fileName: pathname,",
  "    });",
  "    return { format: 'module', source: out.outputText, shortCircuit: true };",
  "  }",
  "  return nextLoad(url, context);",
  "}",
].join("\n");
const loaderPath = path.join(sandbox, "verify-redeem-deeplink-loader.mjs");
writeFileSync(loaderPath, loaderSource);
register(pathToFileURL(loaderPath).href);

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log("  PASS  " + label);
  } else {
    failed += 1;
    console.log("  FAIL  " + label + (detail ? ": " + detail : ""));
  }
}

const CODE = "ABCD-EFGH-JKLM";
let db = null;
try {
  const { ensureDbReady } = await import("@/lib/core/db");
  db = await ensureDbReady();

  // D1：归一化唯一实现从 redeem 页命名导出导入。
  const redeemPage = await import(pathToFileURL(path.join(workspace, "app/dashboard/redeem/page.tsx")).href);
  const normalize = redeemPage.normalizeRedeemCodeInput;
  check("D1a redeem 页命名导出 normalizeRedeemCodeInput", typeof normalize === "function", typeof normalize);
  check(
    "D1b 首尾空白 + 大小写 + 连字符归一化",
    normalize(" abc-EFGH-jklm ") === "ABC-EFGH-JKLM",
    JSON.stringify(normalize(" abc-EFGH-jklm ")),
  );
  check(
    "D1c 12 位裸码补连字符（规则：ABCDEFGHIJKL → ABCD-EFGH-IJKL）",
    normalize("abcdefghijkl") === "ABCD-EFGH-IJKL",
    JSON.stringify(normalize("abcdefghijkl")),
  );
  check(
    "D1d 12 位裸码补连字符（契约示例目标形：abcdefghjklm → ABCD-EFGH-JKLM）",
    normalize("abcdefghjklm") === CODE,
    JSON.stringify(normalize("abcdefghjklm")),
  );
  check(
    "D1e 内部空白全部移除后再补连字符",
    normalize("ab cd ef gh ij kl") === "ABCD-EFGH-IJKL",
    JSON.stringify(normalize("ab cd ef gh ij kl")),
  );
  check("D1f 非法字符仅做大写，交由后端判不存在", normalize(" bad_code ") === "BAD_CODE", JSON.stringify(normalize(" bad_code ")));
  check("D1g 纯空白归一化为空串", normalize("   ") === "", JSON.stringify(normalize("   ")));

  // D3：/r 路由决策函数从真实页面模块导入。
  const deepLinkPage = await import(pathToFileURL(path.join(workspace, "app/r/[code]/page.tsx")).href);
  const target = deepLinkPage.deepLinkTarget;
  check("D3a /r 页命名导出 deepLinkTarget", typeof target === "function", typeof target);
  check(
    "D3b 未登录跳 /login 且 next 保留 /r 路径",
    target(false, CODE) === "/login?next=" + encodeURIComponent("/r/" + CODE),
    target(false, CODE),
  );
  check(
    "D3c 已登录转发 /dashboard/redeem?code=",
    target(true, CODE) === "/dashboard/redeem?code=" + encodeURIComponent(CODE),
    target(true, CODE),
  );
  check("D3d 空码回退无参兑换页", target(true, "   ") === "/dashboard/redeem", target(true, "   "));
  check("D3e 超长码（>64）回退无参兑换页", target(false, "A".repeat(65)) === "/dashboard/redeem", target(false, "A".repeat(65)));
  check(
    "D3f 大小写/空白只 trim 不归一化，交由兑换页处理",
    target(false, " abcd-efgh-jklm ") === "/login?next=" + encodeURIComponent("/r/abcd-efgh-jklm"),
    target(false, " abcd-efgh-jklm "),
  );
  const { resolveSafeNext } = await import("@/lib/shared/safe-next");
  check("D3g 登录 next 路径可被 resolveSafeNext 接受", resolveSafeNext("/r/" + CODE) === "/r/" + CODE, resolveSafeNext("/r/" + CODE));

  // D2：POST /api/user/redeem 限流（IP 维度，60 秒窗口 10 次）。
  const route = await import("@/app/api/user/redeem/route");
  const rateIp = "198.51.100.10";
  const redeemRequest = (ip) =>
    new Request("https://verify.invalid/api/user/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ code: CODE }),
    });

  const firstTen = [];
  for (let i = 0; i < 10; i += 1) {
    firstTen.push((await route.POST(redeemRequest(rateIp))).status);
  }
  check("D2a 同 IP 前 10 次未被限流（未登录为 401）", firstTen.every((status) => status === 401), firstTen.join(","));

  const eleventh = await route.POST(redeemRequest(rateIp));
  const eleventhBody = await eleventh.json();
  check("D2b 第 11 次返回 429", eleventh.status === 429, "status=" + eleventh.status);
  check(
    "D2c 429 文案精确匹配",
    eleventhBody?.error?.message === "兑换请求过于频繁，请稍后再试",
    eleventhBody?.error?.message,
  );
  check("D2d 429 error.type=rate_limit_error", eleventhBody?.error?.type === "rate_limit_error", eleventhBody?.error?.type);
  check("D2e 429 error.code=429", eleventhBody?.error?.code === "429", eleventhBody?.error?.code);
  const retryAfter = eleventh.headers.get("retry-after");
  check(
    "D2f retry-after 为 1–60 的整数",
    typeof retryAfter === "string" && /^\d+$/.test(retryAfter) && Number(retryAfter) >= 1 && Number(retryAfter) <= 60,
    retryAfter,
  );

  // C15：仅 POST 限流，GET 不计数。
  const getStatuses = [];
  for (let i = 0; i < 12; i += 1) {
    const response = await route.GET(new Request("https://verify.invalid/api/user/redeem", {
      headers: { "x-forwarded-for": rateIp },
    }));
    getStatuses.push(response.status);
  }
  check("D2g 同 IP GET 不受限流影响（均为 401）", getStatuses.every((status) => status === 401), getStatuses.join(","));

  // D4：业务失败 400 信封形状。
  const { signAccessToken, ACCESS_COOKIE_NAME } = await import("@/lib/auth/auth");
  const bcrypt = (await import("bcryptjs")).default;
  const passwordHash = await bcrypt.hash("Verify1234", 4);
  await db.execute(
    "INSERT INTO users (username, password_hash, role, rpm, qps, tpm, enabled) VALUES (?, ?, 'user', -1, -1, -1, 1)",
    ["verifydeeplink", passwordHash],
  );
  const user = await db.queryOne("SELECT id, username, role, token_version FROM users WHERE username = ?", ["verifydeeplink"]);
  const token = signAccessToken(user);
  const businessFailure = await route.POST(new Request("https://verify.invalid/api/user/redeem", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.11",
      cookie: ACCESS_COOKIE_NAME + "=" + token,
    },
    body: JSON.stringify({ code: "NO-SUCH-CODE1" }),
  }));
  const failureBody = await businessFailure.json();
  check("D4a 不存在的兑换码返回 400", businessFailure.status === 400, "status=" + businessFailure.status);
  check(
    "D4b 错误信封含 message/type/param/code",
    typeof failureBody?.error?.message === "string"
      && failureBody?.error?.type === "invalid_request_error"
      && failureBody?.error?.param === "None"
      && failureBody?.error?.code === "400",
    JSON.stringify(failureBody?.error),
  );
  check("D4c 文案为「兑换码不存在」", failureBody?.error?.message === "兑换码不存在", failureBody?.error?.message);

  console.log("");
  console.log(passed + "/" + (passed + failed) + " 通过" + (failed > 0 ? "，存在失败" : ""));
} catch (err) {
  failed += 1;
  console.error("脚本执行异常：" + (err?.stack ?? err));
} finally {
  try { await db?.close(); } catch {}
  try { process.chdir(workspace); } catch {}
  try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
}
process.exit(failed > 0 ? 1 : 0);

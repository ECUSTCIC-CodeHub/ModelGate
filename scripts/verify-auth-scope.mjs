// 验证鉴权范围：API Key 不是账号凭据（ISSUE #66、PR #72、Issue #73）。
//
// 守住四件事，且每件都要守：
//   1) 凭据类 guard（ensureWebUser / ensureUserWithRefresh / ensureAdminWeb）拒绝 API Key，返回 403
//   2) 只读类 guard（ensureUser / ensureAdmin）保留 API Key 通道，不被顺手收紧
//   3) 无凭据时仍是 401，不会因为收紧口径把未登录也误判成 403
//   4) 管理端按「读放行、写收紧」划线：写方法必须 ensureAdminWeb，GET 必须 ensureAdmin，
//      逐文件解析源码比对，新增写接口忘了收紧会被这里挡下来；guard 层再按请求方法兜一层，
//      方法这一侧也测，免得只读端点里挂个写函数就从 API Key 打进去了
//
// 运行：
//   node --loader ./scripts/verify-auth-scope-stubs.mjs scripts/verify-auth-scope.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { signAccessToken } from "@/lib/auth/auth";

// 运行时注册模块桩：具名导入在模块实例化阶段就要解析到，必须早于下面对 guards 的静态求值，
// 所以这里先把注册做完再动态 import guards。
register("./verify-auth-scope-stubs.mjs", import.meta.url);

const {
  ensureAdmin,
  ensureAdminWeb,
  ensureUser,
  ensureUserWithRefresh,
  ensureWebUser,
} = await import("@/lib/auth/guards");

const API_KEY_FORBIDDEN_MESSAGE = "该接口涉及账号凭据，请使用网页登录后操作";
const webToken = signAccessToken({ id: 1, role: "admin", username: "tester", token_version: 1 });

const API_KEY_HEADERS = { authorization: "Bearer sk-gw-test" };
const WEB_HEADERS = { cookie: `vlm-access-token=${webToken}` };

const REJECTED = [ensureWebUser, ensureUserWithRefresh, ensureAdminWeb];
const ALLOWED_WITH_KEY = [ensureUser, ensureAdmin];

function requestWith(headers, method = "GET") {
  return new Request("http://localhost/api/test", { headers, method });
}

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`场景 ${name}: OK`);
  } catch (error) {
    failed += 1;
    console.error(`场景 ${name}: FAIL`, error.message);
  }
}

for (const guard of REJECTED) {
  await check(`${guard.name} 拒绝 API Key`, async () => {
    const result = await guard(requestWith(API_KEY_HEADERS));
    assert.ok("error" in result, "预期返回错误");
    assert.equal(result.error.status, 403);
    const body = await result.error.json();
    assert.equal(body.error.message, API_KEY_FORBIDDEN_MESSAGE);
  });

  await check(`${guard.name} 放行 Web 会话`, async () => {
    const result = await guard(requestWith(WEB_HEADERS));
    assert.ok("auth" in result, "预期通过");
    assert.equal(result.auth.authSource, "web");
  });

  await check(`${guard.name} 无凭据仍是 401`, async () => {
    const result = await guard(requestWith({}));
    assert.ok("error" in result, "预期返回错误");
    assert.equal(result.error.status, 401);
  });
}

for (const guard of ALLOWED_WITH_KEY) {
  await check(`${guard.name} 保留 API Key 通道`, async () => {
    const result = await guard(requestWith(API_KEY_HEADERS));
    assert.ok("auth" in result, "预期通过");
    assert.equal(result.auth.authSource, "apikey");
    assert.equal(result.auth.user.role, "admin");
  });
}

// 调用点契约：这两处收不收紧是权衡出来的，回归了没人会发现，所以直接读源码比对。
// available-models 若换成 ensureWebUser，dsh-cic 的模型发现会被静默吞掉，退化成单一 fallback 模型；
// email/send 接受任意收件人，是现成的垃圾邮件出口，必须限定 Web 会话。
const CALL_SITES = [
  { path: "app/api/dashboard/available-models/route.ts", guard: "ensureUser", methods: null },
  { path: "app/api/admin/email/send/route.ts", guard: "ensureAdminWeb", methods: null },
];

// 管理端写操作必须只认 Web 会话：一枚泄漏的管理员密钥能改渠道 base_url、建 admin、
// 改任意用户密码、覆盖 webhook_secret，放行等于整站接管。GET 反之必须保持 API Key 可用，
// 免得把「只读不受影响」的承诺反过来收紧。逐文件解析，新增 route 自动纳入。
//
// 光比对「用了哪条 guard」不够：只读端点里挂一个写函数，还是能被 API Key 打到。
// 因此管到运行时真正的判断条件——ensureAdminWeb 对任何方法都拒绝 API Key，
// 它只能出现在 GET；ensureAdmin 只对读方法放行 API Key，所以写到它上面的方法必须再收紧一次。
const ADMIN_ROOT = "app/api/admin";
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const STRICT_GUARD = "ensureAdminWeb";
const READ_GUARD = "ensureAdmin";

function adminRouteFiles(dir) {
  return readdirSync(dir)
    .flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return adminRouteFiles(full);
      return name === "route.ts" ? [full.split(path.sep).join("/")] : [];
    })
    .sort();
}

// 只取每个 handler 函数体开头的一小段：guard 调用必须出现在任何分支之前，
// 免得分支里的别名调用被误判成「已收紧」。
function handlerGuards(source) {
  const found = [];
  const marker = /export async function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
  const hits = [...source.matchAll(marker)];
  for (const [index, hit] of hits.entries()) {
    const end = hits[index + 1]?.index ?? source.length;
    const segment = source.slice(hit.index, Math.min(end, hit.index + 400));
    const real = segment.match(new RegExp(`await (${STRICT_GUARD}|${READ_GUARD})[(]`));
    found.push({ method: hit[1], guard: real?.[1] ?? null });
  }
  return found;
}

const adminFiles = adminRouteFiles(ADMIN_ROOT);
assert.ok(adminFiles.length > 0, "未找到管理端 route，路径解析可能失效");

for (const file of adminFiles) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const handlers = handlerGuards(source);
  if (handlers.length === 0) continue;
  const isRead = (handler) => READ_METHODS.has(handler.method);

  await check(`${file} 每个写方法都收紧到 ${STRICT_GUARD}`, async () => {
    for (const handler of handlers.filter((item) => !isRead(item))) {
      assert.equal(handler.guard, STRICT_GUARD, `${handler.method} 应使用 ${STRICT_GUARD}，实际 ${handler.guard}`);
    }
  });

  await check(`${file} 读方法保留 ${READ_GUARD}`, async () => {
    for (const handler of handlers.filter((item) => item.method === "GET")) {
      assert.equal(handler.guard, READ_GUARD, `GET 应使用 ${READ_GUARD}，实际 ${handler.guard}`);
    }
  });

  await check(`${file} 严格 guard 未用在读方法上`, async () => {
    for (const handler of handlers.filter((item) => item.method === "GET")) {
      assert.notEqual(handler.guard, STRICT_GUARD, `GET 不应使用 ${STRICT_GUARD}，只读承诺会被反过来收紧`);
    }
  });
}

// guard 层兜底：ensureAdmin 只对读方法放行 API Key，这样即使某个新 route 忘了换严格 guard，
// 写方法也打不进去；ensureAdminWeb 必须对任何方法都拒绝。
for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
  await check(`ensureAdminWeb 在 ${method} 上拒绝 API Key`, async () => {
    const result = await ensureAdminWeb(requestWith(API_KEY_HEADERS, method));
    assert.ok("error" in result, "预期返回错误");
    assert.equal(result.error.status, 403);
  });
}

for (const method of READ_METHODS) {
  await check(`ensureAdmin 在 ${method} 上保留 API Key`, async () => {
    const result = await ensureAdmin(requestWith(API_KEY_HEADERS, method));
    assert.ok("auth" in result, "预期通过");
    assert.equal(result.auth.authSource, "apikey");
  });
}

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  await check(`ensureAdmin 在 ${method} 上也拒绝 API Key`, async () => {
    const result = await ensureAdmin(requestWith(API_KEY_HEADERS, method));
    assert.ok("error" in result, "预期返回错误");
    assert.equal(result.error.status, 403);
  });
}

for (const site of CALL_SITES) {
  await check(`${site.path} 使用 ${site.guard}`, async () => {
    const source = readFileSync(new URL(`../${site.path}`, import.meta.url), "utf8");
    assert.ok(source.includes(`await ${site.guard}(request)`), `${site.path} 应使用 ${site.guard}`);
  });
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);

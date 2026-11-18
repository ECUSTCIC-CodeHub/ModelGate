// 验证鉴权范围：API Key 不是账号凭据（ISSUE #66、PR #72）。
//
// 守住两件事，且两件都要守：
//   1) 凭据类 guard（ensureWebUser / ensureUserWithRefresh / ensureAdminWeb）拒绝 API Key，返回 403
//   2) 只读类 guard（ensureUser / ensureAdmin）保留 API Key 通道，不被顺手收紧
//   3) 无凭据时仍是 401，不会因为收紧口径把未登录也误判成 403
//   4) 少数「值得收紧但不显眼」的调用点当前用的哪条 guard，直接读源码比对
//
// 运行：
//   node --loader ./scripts/verify-auth-scope-stubs.mjs scripts/verify-auth-scope.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

function requestWith(headers) {
  return new Request("http://localhost/api/test", { headers });
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
  { path: "app/api/dashboard/available-models/route.ts", guard: "ensureUser" },
  { path: "app/api/admin/email/send/route.ts", guard: "ensureAdminWeb" },
];

for (const site of CALL_SITES) {
  await check(`${site.path} 使用 ${site.guard}`, async () => {
    const source = readFileSync(new URL(`../${site.path}`, import.meta.url), "utf8");
    assert.ok(source.includes(`await ${site.guard}(request)`), `${site.path} 应使用 ${site.guard}`);
  });
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);

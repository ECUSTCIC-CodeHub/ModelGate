// 验证「自有档按秒数接管组档」后的继承计数清理（T1–T10）。
// 真实链路：临时 SQLite 库 + 真实 DB 初始化 + 真实 admin 路由 + 真实判定/展示。
// 运行：node scripts/verify-period-cycle-takeover.mjs
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
const sandbox = mkdtempSync(path.join(tmpdir(), "period-takeover-verify-"));
process.chdir(sandbox);

const loaderSource = [
  "import { existsSync } from 'node:fs';",
  "import { fileURLToPath, pathToFileURL } from 'node:url';",
  "import path from 'node:path';",
  "const ROOT = process.env.__VERIFY_ROOT__;",
  "function firstExisting(base) {",
  "  const candidates = [base + '.ts', base + '.tsx', path.join(base, 'index.ts'), base];",
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
  "  if (specifier === 'next/server') return nextResolve(pathToFileURL(path.join(ROOT, 'node_modules/next/server.js')).href, context);",
  "  return nextResolve(specifier, context);",
  "}",
].join("\n");
const loaderPath = path.join(sandbox, "verify-period-takeover-loader.mjs");
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

const resetAt = () => new Date(Date.now() + 1800e3).toISOString().slice(0, 19).replace("T", " ");

let db = null;
let adminToken = "";
function req(pathname, method, body) {
  return new Request("https://verify.invalid" + pathname, {
    method,
    headers: { "content-type": "application/json", cookie: "vlm-access-token=" + adminToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

try {
  const { ensureDbReady } = await import("@/lib/core/db");
  db = await ensureDbReady();
  const { signAccessToken } = await import("@/lib/auth/auth");
  const bcrypt = (await import("bcryptjs")).default;
  const userDetail = await import("@/app/api/admin/users/[id]/route");
  const userList = await import("@/app/api/admin/users/route");
  const userQuota = await import("@/app/api/user/quota/route");
  const { checkQuota } = await import("@/lib/gateway/quota");

  const hash = await bcrypt.hash("Verify1234", 4);
  await db.execute(
    "INSERT INTO users (username, password_hash, role, rpm, qps, tpm, enabled) VALUES ('verifyadmin', ?, 'admin', -1, -1, -1, 1)",
    [hash],
  );
  const admin = await db.queryOne("SELECT id, username, role, token_version FROM users WHERE username = 'verifyadmin'");
  adminToken = signAccessToken(admin);

  // 组档：每日 5 请求
  await db.execute("INSERT INTO `groups` (name, qps, rpm, tpm, period_cycles) VALUES ('verify-takeover', -1, -1, -1, ?)", [
    JSON.stringify([{ id: "g1", seconds: 86400, quota_requests: 5, quota_tokens: null }]),
  ]);
  const group = await db.queryOne("SELECT id FROM `groups` WHERE name = 'verify-takeover'");

  async function createUser(username, groupPeriodCycles) {
    await db.execute(
      "INSERT INTO users (username, password_hash, role, group_id, rpm, qps, tpm, enabled, group_period_cycles) VALUES (?, ?, 'admin', ?, -1, -1, -1, 1, ?)",
      [username, hash, group.id, groupPeriodCycles],
    );
    return db.queryOne("SELECT id, username, role, token_version FROM users WHERE username = ?", [username]);
  }

  const inheritedRaw = JSON.stringify([
    { id: "p1", seconds: 86400, quota_requests: 5, quota_tokens: null, used_tokens: 0, used_requests: 4, reset_at: resetAt() },
  ]);

  async function putCycles(userId, cycles) {
    const res = await userDetail.PUT(req("/api/admin/users/" + userId, "PUT", { period_cycles: cycles }), {
      params: Promise.resolve({ id: String(userId) }),
    });
    return { status: res.status, body: await res.json() };
  }

  async function storedInherited(userId) {
    const row = await db.queryOne("SELECT group_period_cycles AS g FROM users WHERE id = ?", [userId]);
    return row?.g ?? null;
  }

  async function periodsOf(userId) {
    const row = await db.queryOne("SELECT id, username, role, token_version FROM users WHERE id = ?", [userId]);
    const token = signAccessToken(row);
    const res = await userQuota.GET(new Request("https://verify.invalid/api/user/quota", { headers: { cookie: "vlm-access-token=" + token } }));
    return (await res.json()).periods;
  }

  // T1：接管同秒数后，组档那一秒的计数不再生效
  const u1 = await createUser("verifytakeover1", inheritedRaw);
  const t1 = await putCycles(u1.id, [{ seconds: 86400, quota_requests: 100, quota_tokens: null }]);
  check("T1a 提交同秒数自有档返回 200", t1.status === 200, "status=" + t1.status + " body=" + JSON.stringify(t1.body).slice(0, 300));
  check("T1b 判定按自有档口径放行", (await checkQuota(u1.id, 0)).ok === true);
  const t1periods = await periodsOf(u1.id);
  check("T1c 该秒数只出现一条且取自有档口径", t1periods.filter((p) => p.period_seconds === 86400).length === 1 && t1periods.find((p) => p.period_seconds === 86400)?.quota_requests === 100, JSON.stringify(t1periods));

  // T2：组档扩到别的秒数后，新秒数按组档生效，用户侧与后台列表同口径
  await db.execute("UPDATE `groups` SET period_cycles = ? WHERE id = ?", [
    JSON.stringify([
      { id: "g1", seconds: 86400, quota_requests: 5, quota_tokens: null },
      { id: "g2", seconds: 3600, quota_requests: 7, quota_tokens: null },
    ]),
    group.id,
  ]);
  const t2periods = await periodsOf(u1.id);
  check("T2a 组档新增的秒数按组档回传", t2periods.some((p) => p.period_seconds === 3600 && p.quota_requests === 7), JSON.stringify(t2periods));
  const listRes = await userList.GET(req("/api/admin/users?limit=20&offset=0", "GET"));
  const listed = (await listRes.json()).data.find((r) => r.id === u1.id);
  const t2aLive = (listed?.periods ?? []).find((p) => p.period_seconds === 3600);
  check("T2b 后台列表与用户侧同口径", t2aLive?.quota_requests === 7, JSON.stringify(listed?.periods));
  check("T2c 后台列表仍展示自有档", (listed?.periods ?? []).some((p) => p.period_seconds === 86400), JSON.stringify(listed?.periods));
  await db.execute("UPDATE `groups` SET period_cycles = ? WHERE id = ?", [
    JSON.stringify([{ id: "g1", seconds: 86400, quota_requests: 5, quota_tokens: null }]),
    group.id,
  ]);

  // T3：组档扩到别的秒数后，被接管的秒数不再作为生效档位出现
  await db.execute("UPDATE `groups` SET period_cycles = ? WHERE id = ?", [
    JSON.stringify([{ id: "g1", seconds: 604800, quota_requests: 5, quota_tokens: null }]),
    group.id,
  ]);
  const t3periods = await periodsOf(u1.id);
  const t3daily = t3periods.filter((p) => p.period_seconds === 86400);
  check("T3a 被接管的秒数只按自有档口径出现一条", t3daily.length === 1 && t3daily[0].quota_requests === 100 && t3daily[0].used_requests === 0, JSON.stringify(t3daily));
  await db.execute("UPDATE `groups` SET period_cycles = ? WHERE id = ?", [
    JSON.stringify([{ id: "g1", seconds: 86400, quota_requests: 5, quota_tokens: null }]),
    group.id,
  ]);

  // T4：组里删掉的秒数在下一次提交周期档时被清掉，重复编辑不堆积残留
  const u4 = await createUser("verifytakeover4", inheritedRaw);
  await db.execute("UPDATE `groups` SET period_cycles = ? WHERE id = ?", [
    JSON.stringify([{ id: "h1", seconds: 604800, quota_requests: 9, quota_tokens: null }]),
    group.id,
  ]);
  await putCycles(u4.id, [{ seconds: 3600, quota_requests: 100, quota_tokens: null }]);
  const t4kept = JSON.parse((await storedInherited(u4.id)) ?? "[]").map((cycle) => cycle.seconds);
  check("T4a 组里已删除的秒数不再留在继承计数里", !t4kept.includes(86400), String(await storedInherited(u4.id)));
  await db.execute("UPDATE `groups` SET period_cycles = ? WHERE id = ?", [
    JSON.stringify([{ id: "g1", seconds: 86400, quota_requests: 5, quota_tokens: null }]),
    group.id,
  ]);

  // T5：同秒数只保留自有档，自有档计数来自 users.period_cycles
  const u5 = await createUser("verifytakeover5", inheritedRaw);
  const t5 = await putCycles(u5.id, [{ seconds: 86400, quota_requests: 2, quota_tokens: null }]);
  check("T5-0 提交同秒数自有档返回 200", t5.status === 200, "status=" + t5.status);
  const t5stored = await db.queryOne("SELECT period_cycles AS p, group_period_cycles AS g FROM users WHERE id = ?", [u5.id]);
  check("T5a 自有档写在 period_cycles 上", JSON.parse(t5stored.p)[0].seconds === 86400, String(t5stored.p));
  check("T5b 自有档计数落在 period_cycles", JSON.parse(t5stored.p)[0].seconds === 86400, String(t5stored.p));
  const t5periods = await periodsOf(u5.id);
  check("T5c 该秒数只出现一条", t5periods.filter((p) => p.period_seconds === 86400).length === 1, JSON.stringify(t5periods));
  check("T5d 判定按自有档 2 次口径放行", (await checkQuota(u5.id, 0)).ok === true);

  // T6：不传 period_cycles 的编辑不动继承计数（别人的用量不能被顺手抹掉）
  const u6 = await createUser("verifytakeover6", inheritedRaw);
  const t6 = await userDetail.PUT(req("/api/admin/users/" + u6.id, "PUT", { note: "只改备注" }), {
    params: Promise.resolve({ id: String(u6.id) }),
  });
  check("T6a 只改备注返回 200", t6.status === 200, "status=" + t6.status);
  check("T6b 未提交周期档时继承计数原样保留", (await storedInherited(u6.id)) === inheritedRaw, String(await storedInherited(u6.id)));

  // T7：清空自有档后，组档重新生效且旧计数已不在（组档从 0 起算）
  const u7 = await createUser("verifytakeover7", inheritedRaw);
  await putCycles(u7.id, [{ seconds: 3600, quota_requests: 100, quota_tokens: null }]);
  await putCycles(u7.id, []);
  const t7periods = await periodsOf(u7.id);
  const t7daily = t7periods.find((p) => p.period_seconds === 86400);
  check("T7a 清空自有档后组档重新出现", Boolean(t7daily), JSON.stringify(t7periods));
  check("T7b 重新生效的组档保留原计数（未被误清）", t7daily?.used_requests === 4, JSON.stringify(t7daily));
  check("T7c 判定按组档 5 次口径放行", (await checkQuota(u7.id, 0)).ok === true);

  // T8：组里删除某档后，其继承计数不再作为生效档位出现
  const u8 = await createUser("verifytakeover8", inheritedRaw);
  await db.execute("INSERT INTO `groups` (name, qps, rpm, tpm, period_cycles) VALUES ('verify-takeover-2', -1, -1, -1, ?)", [
    JSON.stringify([{ id: "h1", seconds: 3600, quota_requests: 3, quota_tokens: null }]),
  ]);
  const group2 = await db.queryOne("SELECT id FROM `groups` WHERE name = 'verify-takeover-2'");
  await db.execute("UPDATE users SET group_id = ?, group_period_cycles = ? WHERE id = ?", [
    group2.id,
    JSON.stringify([{ id: "p1", seconds: 86400, quota_requests: 5, quota_tokens: null, used_tokens: 0, used_requests: 4, reset_at: resetAt() }]),
    u8.id,
  ]);
  const t8periods = await periodsOf(u8.id);
  const t8real = t8periods.filter((p) => !String(p.id).startsWith("unconfigured-"));
  check("T8 组里已删除的秒数不再作为生效档位回传", t8real.every((p) => p.period_seconds === 3600), JSON.stringify(t8real));

  // T9：新建用户不受残留影响（POST 路径同口径）
  const t9res = await userList.POST(req("/api/admin/users", "POST", {
    username: "verifytakeover9",
    password: "Verify1234",
    group_id: group.id,
    period_cycles: [{ seconds: 3600, quota_requests: 100, quota_tokens: null }],
  }));
  const t9body = await t9res.json();
  check("T9a 新建用户返回 201", t9res.status === 201, "status=" + t9res.status);
  check("T9a-2 新建用户 group_period_cycles 与生效组档口径一致", (await storedInherited(t9body.data.id)) === null || JSON.parse(await storedInherited(t9body.data.id)).length === 1, String(await storedInherited(t9body.data.id)));

  // T9b：关闭「继承组周期配额」后，组档秒数一律不再生效，计数也不该留着
  const uInheritOff = await createUser("verifytakeoveroff", inheritedRaw);
  const resOff = await userDetail.PUT(req("/api/admin/users/" + uInheritOff.id, "PUT", {
    inherit_group_periods: false,
    period_cycles: [{ seconds: 3600, quota_requests: 100, quota_tokens: null }],
  }), { params: Promise.resolve({ id: String(uInheritOff.id) }) });
  check("T9b-1 关闭继承返回 200", resOff.status === 200, "status=" + resOff.status);
  check("T9b-2 关闭继承后继承计数被清空", (await storedInherited(uInheritOff.id)) === null, String(await storedInherited(uInheritOff.id)));
  const offPeriods = await periodsOf(uInheritOff.id);
  const offReal = offPeriods.filter((p) => !String(p.id).startsWith("unconfigured-"));
  check("T9b-3 关闭继承后组档不再出现在展示里", offReal.every((p) => p.period_seconds !== 86400), JSON.stringify(offReal));

  // T10：未接管的组档秒数照常展示与判定，不被清理逻辑误伤
  const u10 = await createUser("verifytakeover10", inheritedRaw);
  const t10periods = await periodsOf(u10.id);
  check("T10a 未接管时组档读数照常展示", t10periods.find((p) => p.period_seconds === 86400)?.used_requests === 4, JSON.stringify(t10periods));
  check("T10b 未接管时组档剩余额度照常计算（5-4=1）", t10periods.find((p) => p.period_seconds === 86400)?.remaining_requests === 1, JSON.stringify(t10periods));

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

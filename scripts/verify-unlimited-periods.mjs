// 验证周期配额的三态：留空（继承组档）/ -1（不限制，覆盖组）/ 数值（覆盖组）：真实 SQLite + 真实 admin 路由 + 真实 checkQuota/addUsage。
// 运行：node scripts/verify-unlimited-periods.mjs（自举 --experimental-transform-types 并注册 @/ 别名 loader）
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
const sandbox = mkdtempSync(path.join(tmpdir(), "period-quota-verify-"));
process.chdir(sandbox);

// 自带 loader：@/ 别名 + next/server 显式补 .js（Node ESM 不开 package exports 的无后缀解析）
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
const loaderPath = path.join(sandbox, "verify-period-quota-loader.mjs");
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

let adminToken = "";
function adminRequest(pathname, method, body) {
  return new Request("https://verify.invalid" + pathname, {
    method,
    headers: { "content-type": "application/json", cookie: "vlm-access-token=" + adminToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const DAY = 86400;
let db = null;
try {
  const { ensureDbReady } = await import("@/lib/core/db");
  db = await ensureDbReady();

  const { signAccessToken } = await import("@/lib/auth/auth");
  const detailRoute = await import("@/app/api/admin/users/[id]/route");
  const groupDetailRoute = await import("@/app/api/admin/groups/[id]/route");
  const { appendQuotaHeaders, checkQuota, resolveEffectivePeriods } = await import("@/lib/gateway/quota");
  const { getEffectiveLimits } = await import("@/lib/gateway/effective-limits");
  const { addUsage } = await import("@/lib/gateway/usage-accounting");
  const { parsePeriodCycles } = await import("@/lib/gateway/period-cycles");
  const bcrypt = (await import("bcryptjs")).default;

  const adminGroup = await db.queryOne("SELECT id FROM `groups` WHERE is_default = 1 AND deleted_at IS NULL");
  const G = adminGroup.id;

  async function createUser(username, { role = "user", groupId = G } = {}) {
    const hash = await bcrypt.hash("Verify1234", 4);
    await db.execute(
      "INSERT INTO users (username, password_hash, role, group_id, rpm, qps, tpm, enabled) VALUES (?, ?, ?, ?, -1, -1, -1, 1)",
      [username, hash, role, groupId],
    );
    return db.queryOne("SELECT id, username, role, token_version FROM users WHERE username = ?", [username]);
  }

  const adminRow = await createUser("verifyadmin", { role: "admin" });
  const admin = await db.queryOne("SELECT id, username, role, token_version FROM users WHERE id = ?", [adminRow.id]);
  adminToken = signAccessToken(admin);

  async function setGroupCycles(groupId, cycles) {
    const res = await groupDetailRoute.PUT(
      adminRequest("/api/admin/groups/" + groupId, "PUT", { period_cycles: cycles }),
      { params: Promise.resolve({ id: String(groupId) }) },
    );
    return { status: res.status, body: await res.json() };
  }

  async function setUserCycles(userId, periodCycles) {
    const res = await detailRoute.PUT(
      adminRequest("/api/admin/users/" + userId, "PUT", { period_cycles: periodCycles }),
      { params: Promise.resolve({ id: String(userId) }) },
    );
    return { status: res.status, body: await res.json() };
  }

  async function storedUser(userId) {
    return db.queryOne("SELECT period_cycles, group_period_cycles FROM users WHERE id = ?", [userId]);
  }

  function dayCycles(raw) {
    return parsePeriodCycles(raw).filter((cycle) => cycle.seconds === DAY);
  }

  // 组配「每天 10 请求」
  const groupSet = await setGroupCycles(G, [{ seconds: DAY, quota_requests: 10, quota_tokens: null }]);
  check("S0 组周期档设置成功", groupSet.status === 200, "status=" + groupSet.status + " body=" + JSON.stringify(groupSet.body).slice(0, 200));

  const alice = await createUser("verifyalice");
  const before = await storedUser(alice.id);
  check("S1 新建用户时未签发自有档（组档照常继承）", before.period_cycles === null, "period_cycles=" + before.period_cycles);

  const inherit = await checkQuota(alice.id, 0);
  const inheritDay = inherit.quota.periods.find((p) => p.period_seconds === DAY);
  check("S2 未配置时判定侧继承组档（每日 10 请求）", inherit.ok === true && inheritDay?.quota_requests === 10, JSON.stringify(inheritDay));

  // 用满组档：10 次请求后第 11 次被拒
  for (let i = 0; i < 10; i += 1) await addUsage(alice.id, (await db.queryOne("SELECT id FROM `keys` WHERE user_id = ?", [alice.id]))?.id ?? 0, 0, 1);
  const blocked = await checkQuota(alice.id, 0);
  check("S3 组档用满后被拒", blocked.ok === false && String(blocked.reason).includes("周期请求配额已用尽"), JSON.stringify(blocked).slice(0, 200));

  // 留空 = 继承：提交两项都为 null 的档位，不改用户自有档
  const submitInherit = await setUserCycles(alice.id, [{ seconds: DAY, quota_tokens: null, quota_requests: null }]);
  check("S4 提交留空档位被接受（留空 = 继承）", submitInherit.status === 200, "status=" + submitInherit.status + " body=" + JSON.stringify(submitInherit.body).slice(0, 200));
  const afterInherit = await storedUser(alice.id);
  // 留空必须原样保留 null：抄组档额度进自有档就等于把组档物化，组后续调整对该用户失效。
  check("S5 留空档位不落成组档额度（保留 null 以便跟随组档）", dayCycles(afterInherit.period_cycles)[0]?.quota_requests === null, "period_cycles=" + afterInherit.period_cycles);
  const stillBlocked = await checkQuota(alice.id, 0);
  // 用户自有的覆盖档从 0 起算（不搬组档历史用量），因此这条档位重新给满额度
  check("S6 留空后仍受同一条每日档约束", stillBlocked.ok === true && stillBlocked.quota.periods.find((p) => p.period_seconds === DAY)?.quota_requests === 10, JSON.stringify(stillBlocked.quota.periods).slice(0, 200));

  // -1 = 不限制（覆盖组）
  const submitUnlimited = await setUserCycles(alice.id, [{ seconds: DAY, quota_tokens: -1, quota_requests: -1 }]);
  check("S7 提交 -1 档位被接受", submitUnlimited.status === 200, "status=" + submitUnlimited.status + " body=" + JSON.stringify(submitUnlimited.body).slice(0, 200));
  const afterUnlimited = await storedUser(alice.id);
  check("S8 -1 档位落成用户自有档", dayCycles(afterUnlimited.period_cycles)[0]?.quota_requests === -1, "period_cycles=" + afterUnlimited.period_cycles);
  const bypassed = await checkQuota(alice.id, 0);
  check("S9 -1 覆盖组档后放行（原来已用满）", bypassed.ok === true, JSON.stringify(bypassed).slice(0, 160));

  // 改回继承：提交空数组清空自有档，回到受组档约束
  const submitEmpty = await setUserCycles(alice.id, []);
  check("S10 提交空数组清空自有档", submitEmpty.status === 200 && (await storedUser(alice.id)).period_cycles === null, "period_cycles=" + (await storedUser(alice.id)).period_cycles);
  const backToGroup = await checkQuota(alice.id, 0);
  check("S11 清空后重新受组档约束", backToGroup.ok === false, JSON.stringify(backToGroup).slice(0, 160));

  // 字段缺省 = 不动
  const noop = await detailRoute.PUT(
    adminRequest("/api/admin/users/" + alice.id, "PUT", { note: "keep" }),
    { params: Promise.resolve({ id: String(alice.id) }) },
  );
  check("S12 未提交周期字段时保持原值", noop.status === 200 && (await storedUser(alice.id)).period_cycles === null, "status=" + noop.status);

  // 字段内额度留空但组里没有该周期 → 落成 -1（否则这条档位永远不生效）
  const bob = await createUser("verifybob");
  const bobWeek = await setUserCycles(bob.id, [{ seconds: 604800, quota_tokens: null, quota_requests: null }]);
  const bobWeekStored = parsePeriodCycles((await storedUser(bob.id)).period_cycles).filter((c) => c.seconds === 604800);
  check("S13 组里没有该周期时留空档位落成 -1", bobWeek.status === 200 && bobWeekStored[0]?.quota_requests === -1, "stored=" + (await storedUser(bob.id)).period_cycles);

  // 只填一侧额度：另一侧不应静默作废组档
  // 组档恢复成「每天 10 请求」，且新用户从零开始，避免被前面用满的计数干扰
  await setGroupCycles(G, [{ seconds: DAY, quota_requests: 10, quota_tokens: null }]);
  const carol = await createUser("verifycarol");
  const partial = await setUserCycles(carol.id, [{ seconds: DAY, quota_tokens: 1000, quota_requests: null }]);
  check("S14 只填 Token 的档位被接受", partial.status === 200, "status=" + partial.status);
  const carolUser = await db.queryOne("SELECT * FROM users WHERE id = ?", [carol.id]);
  const carolLimits = await getEffectiveLimits(carolUser);
  const carolPeriods = await resolveEffectivePeriods(carol.id, carolLimits.period_cycles, carolUser.period_cycles);
  const carolDay = carolPeriods.find((p) => p.period_seconds === DAY);
  check("S15 只填 Token 时组的请求额度仍生效", carolDay?.quota_requests === 10 && carolDay?.quota_tokens === 1000, JSON.stringify(carolDay));

  // 计费侧：-1 档位不产生消耗，继承档写入 group_period_cycles
  const dave = await createUser("verifydave");
  await setUserCycles(dave.id, [{ seconds: DAY, quota_tokens: -1, quota_requests: -1 }]);
  await db.execute("INSERT INTO `keys` (`key`, name, user_id, enabled) VALUES (?, 'k', ?, 1)", ["verify-dave-key", dave.id]);
  const daveKeyRow = await db.queryOne("SELECT id FROM `keys` WHERE user_id = ?", [dave.id]);
  await addUsage(dave.id, daveKeyRow.id, 100, 1);
  const daveStored = await storedUser(dave.id);
  check("S16 -1 档位照常记录用量（判定侧不拦）", dayCycles(daveStored.period_cycles)[0]?.used_requests === 1, "period_cycles=" + daveStored.period_cycles);
  check("S17 覆盖组档后不再累加组档计数", daveStored.group_period_cycles === null, "group_period_cycles=" + daveStored.group_period_cycles);
  const daveQuota = await checkQuota(dave.id, 0);
  check("S18 -1 档位放行且无剩余量", daveQuota.ok === true && daveQuota.quota.periods.find((p) => p.period_seconds === DAY)?.remaining_requests === null, JSON.stringify(daveQuota.quota.periods));

  // 继承档计费仍记在 group_period_cycles
  const erin = await createUser("verifyerin");
  await db.execute("INSERT INTO `keys` (`key`, name, user_id, enabled) VALUES (?, 'k', ?, 1)", ["verify-erin-key", erin.id]);
  const erinKey = await db.queryOne("SELECT id FROM `keys` WHERE user_id = ?", [erin.id]);
  await addUsage(erin.id, erinKey.id, 0, 2);
  const erinStored = await storedUser(erin.id);
  check("S19 继承档计费写入 group_period_cycles", dayCycles(erinStored.group_period_cycles)[0]?.used_requests === 2, "group_period_cycles=" + erinStored.group_period_cycles);
  check("S20 继承档不物化成用户自有档", erinStored.period_cycles === null, "period_cycles=" + erinStored.period_cycles);

  // 组档允许「同一档只限一侧」，留空的那一侧不产生限制（组没有上游可继承）
  const groupPartial = await setGroupCycles(G, [{ seconds: DAY, quota_tokens: null, quota_requests: 4 }]);
  const groupPartialStored = dayCycles(groupPartial.body.data?.period_cycles ?? "[]");
  check("S21 组档同一周期只限一侧时另一侧留空", groupPartial.status === 200 && groupPartialStored[0]?.quota_requests === 4 && groupPartialStored[0]?.quota_tokens === null, "period_cycles=" + JSON.stringify(groupPartialStored));

  // 组档回滚成正常值 + 新增档位，验证继承即时生效
  await setGroupCycles(G, [{ seconds: DAY, quota_requests: 20, quota_tokens: null }, { seconds: 3600, quota_requests: 5, quota_tokens: null }]);
  const frank = await createUser("verifyfrank");
  const frankQuota = await checkQuota(frank.id, 0);
  const frankPeriods = frankQuota.quota.periods.map((p) => p.period_seconds + ":" + p.quota_requests).sort();
  check("S22 组新增档位后用户立即继承", frankPeriods.includes("3600:5") && frankPeriods.includes("86400:20"), JSON.stringify(frankPeriods));

  // 组里没配置的常见周期：补出「未配置」占位档，用户可写 -1 覆盖
  const grace = await createUser("verifygrace");
  await setUserCycles(grace.id, [{ seconds: 86400, quota_tokens: -1, quota_requests: -1 }]);
  const graceUser = await db.queryOne("SELECT * FROM users WHERE id = ?", [grace.id]);
  const graceLimits = await getEffectiveLimits(graceUser);
  const graceAll = graceLimits.period_cycles.all;
  // 86400 已被用户档显式覆盖，其余常见周期是补出来的占位档
  const placeholder = graceAll.filter((c) => c.seconds === 604800 || c.seconds === 2592000);
  check(
    "S23a 组档存在时补出常见周期占位档（额度为 null）",
    graceAll.length === 4
      && placeholder.length === 2
      && placeholder.every((c) => c.quota_requests === null && c.quota_tokens === null),
    JSON.stringify(graceAll.map((c) => [c.seconds, c.quota_requests])),
  );
  const weekAll = graceAll.find((c) => c.seconds === 604800);
  check("S23 未配置的常见周期以未配置档位出现（额度为 null）", weekAll !== undefined && weekAll.quota_requests === null && weekAll.quota_tokens === null, JSON.stringify(graceAll.map((c) => c.seconds)));

  // 组档调整必须持续对用户生效（审计 M1）：自有档只覆盖一侧时，另一侧跟随组档增删改。
  await setGroupCycles(G, [{ seconds: DAY, quota_requests: 10, quota_tokens: null }]);
  const heidi = await createUser("verifyheidi");
  await setUserCycles(heidi.id, [{ seconds: DAY, quota_tokens: 1000, quota_requests: null }]);
  const heidiStored = parsePeriodCycles((await storedUser(heidi.id)).period_cycles).find((c) => c.seconds === DAY);
  check("S24 只覆盖 Token 时请求额度以 null 落库（不物化组档）", heidiStored?.quota_requests === null, JSON.stringify(heidiStored));
  await setGroupCycles(G, [{ seconds: DAY, quota_requests: 20, quota_tokens: null }]);
  const heidiWiden = await checkQuota(heidi.id, 0);
  check("S25 组档放宽后用户跟随", heidiWiden.quota.periods.find((p) => p.period_seconds === DAY)?.quota_requests === 20, JSON.stringify(heidiWiden.quota.periods[0]));
  await setGroupCycles(G, [{ seconds: DAY, quota_requests: 3, quota_tokens: null }]);
  const heidiTight = await checkQuota(heidi.id, 0);
  check("S26 组档收紧后用户跟随", heidiTight.quota.periods.find((p) => p.period_seconds === DAY)?.quota_requests === 3, JSON.stringify(heidiTight.quota.periods[0]));
  await setGroupCycles(G, []);
  const heidiGone = await checkQuota(heidi.id, 0);
  check("S27 组档删除后回落到不限制", heidiGone.quota.periods.find((p) => p.period_seconds === DAY)?.quota_requests === -1, JSON.stringify(heidiGone.quota.periods[0]));

  // 占位档不得污染响应头（审计 H1）：每个 key 都带非空档位 id 且互不覆盖。
  await setGroupCycles(G, [{ seconds: DAY, quota_requests: 10, quota_tokens: null }]);
  const ivan = await createUser("verifyivan");
  const ivanRow = await db.queryOne("SELECT * FROM users WHERE id = ?", [ivan.id]);
  const ivanLimits = await getEffectiveLimits(ivanRow);
  const ivanPeriods = await resolveEffectivePeriods(ivan.id, ivanLimits.period_cycles, ivanRow.period_cycles);
  const ivanHeaders = {};
  appendQuotaHeaders(ivanHeaders, { remaining_requests: null, remaining_tokens: null, periods: ivanPeriods });
  const periodHeaderKeys = Object.keys(ivanHeaders).filter((key) => key.includes("Remaining-"));
  check("S28 周期响应头不出现空后缀 key", periodHeaderKeys.every((key) => !key.endsWith("-")), JSON.stringify(periodHeaderKeys));
  check("S29 周期响应头 key 唯一", new Set(periodHeaderKeys).size === periodHeaderKeys.length, JSON.stringify(periodHeaderKeys));
  check("S30 占位档不写入 group_period_cycles", (await storedUser(ivan.id)).group_period_cycles === null, "group_period_cycles=" + (await storedUser(ivan.id)).group_period_cycles);

  // 打开抽屉不改直接保存（审计 M3）：按 row.period_cycles 回填后原样提交，用户档不得变形。
  const judy = await createUser("verifyjudy");
  const judyBefore = (await storedUser(judy.id)).period_cycles;
  const judyRow = await db.queryOne("SELECT * FROM users WHERE id = ?", [judy.id]);
  const judyDrafts = parsePeriodCycles(judyRow.period_cycles)
    .map((cycle) => ({ seconds: cycle.seconds, quota_tokens: cycle.quota_tokens, quota_requests: cycle.quota_requests }));
  await setUserCycles(judy.id, judyDrafts);
  check("S31 抽屉不改直接保存不新增假档", (await storedUser(judy.id)).period_cycles === judyBefore, "before=" + judyBefore + " after=" + (await storedUser(judy.id)).period_cycles);

  // 两条键空间不能重复计数：留空档的用量只记继承档，显式额度档只记自有档。
  await setGroupCycles(G, [{ seconds: DAY, quota_requests: 100, quota_tokens: null }]);
  const karl = await createUser("verifykarl");
  await setUserCycles(karl.id, [{ seconds: DAY, quota_tokens: null, quota_requests: null }]);
  await db.execute("INSERT INTO `keys` (`key`, name, user_id, enabled) VALUES (?, 'k', ?, 1)", ["verify-karl-key", karl.id]);
  await addUsage(karl.id, (await db.queryOne("SELECT id FROM `keys` WHERE user_id = ?", [karl.id])).id, 10, 3);
  const karlStored = await storedUser(karl.id);
  check("S32 留空档计费不写自有档计数", dayCycles(karlStored.period_cycles)[0]?.used_requests === 0, "period_cycles=" + karlStored.period_cycles);
  check("S33 留空档计费写继承档计数", dayCycles(karlStored.group_period_cycles)[0]?.used_requests === 3, "group_period_cycles=" + karlStored.group_period_cycles);

  // 同一次用量在两条键空间里只能出现一次
  const lena = await createUser("verifylena");
  await setUserCycles(lena.id, [{ seconds: DAY, quota_tokens: -1, quota_requests: -1 }]);
  await db.execute("INSERT INTO `keys` (`key`, name, user_id, enabled) VALUES (?, 'k', ?, 1)", ["verify-lena-key", lena.id]);
  await addUsage(lena.id, (await db.queryOne("SELECT id FROM `keys` WHERE user_id = ?", [lena.id])).id, 10, 1);
  const lenaStored = await storedUser(lena.id);
  const lenaUsed = (dayCycles(lenaStored.period_cycles)[0]?.used_requests ?? 0) + (dayCycles(lenaStored.group_period_cycles)[0]?.used_requests ?? 0);
  check("S34 同一次用量只计一次", lenaUsed === 1, "used_requests=" + lenaUsed);

  // 额度类型必须严格：字符串/小数不再被隐式归一成「继承」
  const badString = await setUserCycles(lena.id, [{ seconds: DAY, quota_tokens: "-1", quota_requests: null }]);
  check("S35 字符串额度被拒", badString.status === 400, "status=" + badString.status);
  const badFloat = await setUserCycles(lena.id, [{ seconds: DAY, quota_tokens: -1.4, quota_requests: null }]);
  check("S36 小数额度被拒", badFloat.status === 400, "status=" + badFloat.status);

  console.log("");
  console.log(passed + "/" + (passed + failed) + " 通过" + (failed > 0 ? "，存在失败" : ""));
} catch (err) {
  failed += 1;
  console.error("脚本执行异常：" + (err?.stack ?? err));
} finally {
  try { await db?.close(); } catch {}
  try { process.chdir(path.dirname(path.resolve(process.env.__VERIFY_ROOT__ ?? process.cwd()))); } catch {}
  try { process.chdir(process.env.__VERIFY_ROOT__); } catch {}
  try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
}
process.exit(failed > 0 ? 1 : 0);

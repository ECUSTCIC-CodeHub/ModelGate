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

  // 显式带上 group_id 与 inherit_group_periods：INSERT 不带 group_id 时，数据库触发器/默认值
  // 可能给出一个新建的组，那个组没有周期档，继承相关的断言会整片失真。
  async function createUser(username, { role = "user", groupId = G } = {}) {
    const hash = await bcrypt.hash("Verify1234", 4);
    await db.execute(
      "INSERT INTO users (username, password_hash, role, group_id, rpm, qps, tpm, enabled, inherit_group_periods) VALUES (?, ?, ?, ?, -1, -1, -1, 1, 1)",
      [username, hash, role, groupId],
    );
    return db.queryOne("SELECT id, username, role, group_id, token_version FROM users WHERE username = ?", [username]);
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
    return db.queryOne("SELECT period_cycles, group_period_cycles, inherit_group_periods FROM users WHERE id = ?", [userId]);
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
  // 组的每日 10 次请求已被前面用满，而留空档的用量记在 group_period_cycles，
  // 判定必须读到那份计数并拦住，不能因为自有档那条计 0 就放行。
  check("S6 留空后仍受组档已用尽的每日请求约束", stillBlocked.ok === false, JSON.stringify(stillBlocked.quota.periods.filter((p) => p.period_seconds === DAY)));

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

  // ---- 周期配额总开关（inherit_group_periods）：关掉即不受组档约束 ----
  const createRoute = await import("@/app/api/admin/users/route");
  const listRoute = await import("@/app/api/admin/users/route");
  const userQuotaRoute = await import("@/app/api/user/quota/route");

  async function patchUser(userId, body) {
    const res = await detailRoute.PUT(
      adminRequest("/api/admin/users/" + userId, "PUT", body),
      { params: Promise.resolve({ id: String(userId) }) },
    );
    return { status: res.status, body: await res.json() };
  }

  // accumulateCycles 只往 group_period_cycles 里写计数，reset_at 仍是 null；
  // 下一次读取会把它当成「还没开窗」，把 used_* 归零重来。真实链路上判定侧
  // （checkQuota）在计费之前已经把窗口推进过，这里用一次 GET 复现同样的顺序，
  // 否则断言会看到「用量莫名清零」而误判。
  async function primeWindows(userId) {
    await userQuotaRoute.GET(userRequest("/api/user/quota", userId));
  }

  function userRequest(pathname, userId) {
    return new Request("https://verify.invalid" + pathname, {
      method: "GET",
      headers: { cookie: "vlm-access-token=" + signAccessToken({ id: userId, role: "user" }) },
    });
  }

  // 两条键空间不能重复计数：留空档的用量只记继承档，显式额度档只记自有档。
  await setGroupCycles(G, [{ seconds: DAY, quota_requests: 100, quota_tokens: null }]);
  const karl = await createUser("verifykarl");
  await setUserCycles(karl.id, [{ seconds: DAY, quota_tokens: null, quota_requests: null }]);
  await db.execute("INSERT INTO `keys` (`key`, name, user_id, enabled) VALUES (?, 'k', ?, 1)", ["verify-karl-key", karl.id]);
  await primeWindows(karl.id);
  await addUsage(karl.id, (await db.queryOne("SELECT id FROM `keys` WHERE user_id = ?", [karl.id])).id, 10, 3);
  const karlStored = await storedUser(karl.id);
  // 留空档保留在用户行里（额度为 null），但计数一律走继承档，两次键空间不能各记一份。
  check("S32 留空档计费不写自有档计数", dayCycles(karlStored.period_cycles)[0]?.used_requests === 0, "period_cycles=" + karlStored.period_cycles);
  check("S33 留空档计费写继承档计数", dayCycles(karlStored.group_period_cycles)[0]?.used_requests === 3, "group_period_cycles=" + karlStored.group_period_cycles);

  // ensureColumn 的缺省值对存量行不生效（ALTER TABLE ADD COLUMN 里 NULL 仍是 NULL），
  // 老用户与直接 INSERT 出来的行读到的都是 null，必须按「继承」处理。
  const legacy = await createUser("verifylegacy");
  await db.execute("UPDATE users SET inherit_group_periods = NULL WHERE id = ?", [legacy.id]);
  await setGroupCycles(G, [{ seconds: DAY, quota_requests: 100, quota_tokens: null }]);
  const legacyQuota = await checkQuota(legacy.id, 0);
  check("S37 总开关为 NULL 的存量行按继承处理", legacyQuota.quota.periods.find((p) => p.period_seconds === DAY)?.quota_requests === 100, JSON.stringify(legacyQuota.quota.periods).slice(0, 200));

  // 组配「每天 3 请求」，先把档位用满
  await setGroupCycles(G, [{ seconds: DAY, quota_requests: 3, quota_tokens: null }]);
  const mia = await createUser("verifymia");
  await setUserCycles(mia.id, []);
  await db.execute("INSERT INTO `keys` (`key`, name, user_id, enabled) VALUES (?, 'k', ?, 1)", ["verify-mia-key", mia.id]);
  const miaKey = await db.queryOne("SELECT id FROM `keys` WHERE user_id = ?", [mia.id]);
  for (let i = 0; i < 3; i += 1) {
    await primeWindows(mia.id);
    await addUsage(mia.id, miaKey.id, 0, 1);
  }
  const miaBlocked = await checkQuota(mia.id, 0);
  check("S38 关闭开关前受组档约束", miaBlocked.ok === false, JSON.stringify({ ok: miaBlocked.ok, reason: miaBlocked.reason }));

  const miaOff = await patchUser(mia.id, { inherit_group_periods: false });
  const miaRow = await storedUser(mia.id);
  check("S39 关闭总开关被接受并落库", miaOff.status === 200 && Number(miaRow.inherit_group_periods) === 0 && miaOff.body?.data?.inherit_group_periods === 0, "status=" + miaOff.status + " inherit=" + miaRow.inherit_group_periods + " body=" + JSON.stringify(miaOff.body).slice(0, 200));
  const miaAllow = await checkQuota(mia.id, 0);
  check("S40 关闭总开关后组档不再拦人", miaAllow.ok === true && miaAllow.quota.periods.every((p) => p.quota_requests !== 3), "ok=" + miaAllow.ok + " periods=" + JSON.stringify(miaAllow.quota.periods.map((p) => [p.period_seconds, p.quota_requests])));
  await primeWindows(mia.id);
  await addUsage(mia.id, miaKey.id, 0, 1);
  await primeWindows(mia.id);
  const miaAfterStored = await storedUser(mia.id);
  // 关闭后组档不再参与，残留的继承计数会被一次计费顺带清掉；
  // 关键断言是「不再增长」，因此允许为空。
  check("S41 关闭后用量不再写继承档计数", miaAfterStored.group_period_cycles === null, "before=" + miaRow.group_period_cycles + " after=" + miaAfterStored.group_period_cycles);

  // 重新打开：组档恢复参与判定，档位原文不受开关影响。
  // 注意关闭期间继承计数已被清掉（组档当时不参与，留着只会让重新打开后凭空带着旧用量），
  // 所以这里断言的是「组档重新参与判定」而不是「立刻被用完的历史量拦住」。
  const miaOn = await patchUser(mia.id, { inherit_group_periods: true });
  const miaOnStored = await storedUser(mia.id);
  const miaRestored = await checkQuota(mia.id, 0);
  check("S42 重新打开开关后组档重新参与判定", miaOn.status === 200 && miaRestored.quota.periods.find((p) => p.period_seconds === DAY)?.quota_requests === 3, "status=" + miaOn.status + " periods=" + JSON.stringify(miaRestored.quota.periods.map((p) => [p.period_seconds, p.quota_requests])));
  check("S43 开关只改标志不动档位原文", miaOnStored.period_cycles === null, "period_cycles=" + miaOnStored.period_cycles);
  await primeWindows(mia.id);
  await addUsage(mia.id, miaKey.id, 0, 3);
  await primeWindows(mia.id);
  const miaRefill = await checkQuota(mia.id, 0);
  check("S43b 重新打开后组档用量重新累计并拦人", miaRefill.ok === false, "ok=" + miaRefill.ok + " used=" + JSON.stringify(miaRefill.quota.periods.find((p) => p.period_seconds === DAY)?.used_requests));

  // 关掉开关时，用户档里还留着「继承」形态的 null 必须固化成 -1，
  // 否则界面上看着关了开关，读取时还会挂在组档上。
  const nina = await createUser("verifynina");
  await patchUser(nina.id, { period_cycles: [{ seconds: DAY, quota_tokens: null, quota_requests: null }] });
  const ninaBefore = parsePeriodCycles((await storedUser(nina.id)).period_cycles).find((c) => c.seconds === DAY);
  check("S44 开着开关时留空档位保留 null（继续继承组档）", ninaBefore?.quota_requests === null, JSON.stringify(ninaBefore));
  const ninaOff = await patchUser(nina.id, { inherit_group_periods: false });
  const ninaAfter = parsePeriodCycles((await storedUser(nina.id)).period_cycles).find((c) => c.seconds === DAY);
  check("S45 关闭开关把留空侧固化成 -1", ninaOff.status === 200 && ninaAfter?.quota_requests === -1 && ninaAfter?.quota_tokens === -1, JSON.stringify(ninaAfter));
  const ninaQuota = await checkQuota(nina.id, 0);
  check("S46 固化后不再受组档约束", ninaQuota.ok === true, JSON.stringify(ninaQuota).slice(0, 160));

  // 关闭状态下提交留空额度：不抄组档额度，留空侧按不限制处理
  const owen = await createUser("verifyowen");
  await patchUser(owen.id, { inherit_group_periods: false });
  const owenSubmit = await patchUser(owen.id, { period_cycles: [{ seconds: DAY, quota_tokens: null, quota_requests: 5 }] });
  const owenCycles = parsePeriodCycles((await storedUser(owen.id)).period_cycles).find((c) => c.seconds === DAY);
  // 关闭继承时没有上游可继承，留空侧固化成 -1（而不是留在 null 上等着重新指向组档），
  // 与「关闭开关」这条路径落库形态一致；提交的数值侧原样保留。
  check("S47 关闭状态提交的留空侧固化成 -1、数值侧原样保留", owenSubmit.status === 200 && owenCycles?.quota_requests === 5 && owenCycles?.quota_tokens === -1, JSON.stringify(owenCycles) + " inheritStored=" + JSON.stringify((await storedUser(owen.id)).inherit_group_periods));
  const owenQuota = await checkQuota(owen.id, 0);
  const owenDay = owenQuota.quota.periods.find((p) => p.period_seconds === DAY);
  check("S48 关闭状态自有档按提交形状生效", owenDay?.quota_requests === 5 && owenDay?.quota_tokens === -1, JSON.stringify(owenDay));

  // 新建接口同样支持总开关
  const peterRes = await createRoute.POST(adminRequest("/api/admin/users", "POST", {
    username: "verifypeter", password: "Verify1234", group_id: G, inherit_group_periods: false,
  }));
  const peterRow = (await peterRes.json())?.data;
  check("S49 新建用户可关闭总开关", peterRes.status === 201 && Number(peterRow?.inherit_group_periods) === 0, "status=" + peterRes.status + " inherit=" + JSON.stringify(peterRow?.inherit_group_periods));

  // 管理端列表 / 用户自查接口都要回传开关的生效值
  const listRes = await listRoute.GET(adminRequest("/api/admin/users?limit=100", "GET"));
  const listBody = await listRes.json();
  const miaListed = (listBody.data ?? []).find((row) => row.id === mia.id);
  check("S50 管理端列表回传总开关", Number(miaListed?.inherit_group_periods) === 1, "inherit=" + miaListed?.inherit_group_periods);
  const peterListed = (listBody.data ?? []).find((row) => row.id === peterRow?.id);
  check("S51 管理端列表对关闭用户不展示组档", Number(peterListed?.inherit_group_periods) === 0 && peterListed?.group_period_cycles === null, JSON.stringify({ inherit: peterListed?.inherit_group_periods, group: peterListed?.group_period_cycles }));
  const owenQuotaBody = await (await userQuotaRoute.GET(userRequest("/api/user/quota", owen.id))).json();
  check("S52 用户自查接口回传总开关", owenQuotaBody.inherit_group_periods === false, "inherit=" + owenQuotaBody.inherit_group_periods);

  // 关掉开关的用户不受「组后续新增档位」影响（这正是开关相对逐档 -1 的价值）
  await setGroupCycles(G, [{ seconds: DAY, quota_requests: 1, quota_tokens: null }, { seconds: 3600, quota_requests: 1, quota_tokens: null }]);
  const quinnQuota = await checkQuota(peterRow.id, 0);
  check("S53 组新增档位不会套到关闭继承的用户身上", quinnQuota.ok === true && quinnQuota.quota.periods.every((p) => p.quota_requests !== 1), JSON.stringify(quinnQuota.quota.periods.map((p) => [p.period_seconds, p.quota_requests])));
  check("S54 关闭用户的周期配额响应里不含组档", quinnQuota.quota.periods.every((p) => !p.id.startsWith("group")), JSON.stringify(quinnQuota.quota.periods.map((p) => p.id)));

  // ---- 关闭继承后提交档位：显式 -1 不能被「原样保存」抹回 null（审计中危 1） ----
  await setGroupCycles(G, [{ seconds: DAY, quota_requests: 50, quota_tokens: null }]);
  const zoe = await createUser("verifyzoe");
  await patchUser(zoe.id, { period_cycles: [{ seconds: DAY, quota_tokens: null, quota_requests: null }] });
  await patchUser(zoe.id, { inherit_group_periods: false });
  const zoeDetached = parsePeriodCycles((await storedUser(zoe.id)).period_cycles).find((c) => c.seconds === DAY);
  check("S55 关闭继承把存量留空档固化成 -1", zoeDetached?.quota_requests === -1 && zoeDetached?.quota_tokens === -1, JSON.stringify(zoeDetached));
  // 管理端打开抽屉、原样再保存一次：显式 -1 是意图，不能被抹回 null（那会变成「跟着组走」）
  const zoeResave = await patchUser(zoe.id, { period_cycles: [{ seconds: DAY, quota_tokens: null, quota_requests: null }] });
  const zoeResaved = parsePeriodCycles((await storedUser(zoe.id)).period_cycles).find((c) => c.seconds === DAY);
  check("S56 关闭状态原样再保存不把 -1 抹回 null", zoeResave.status === 200 && zoeResaved?.quota_requests === -1 && zoeResaved?.quota_tokens === -1, JSON.stringify(zoeResaved));
  // 关闭期间提交的留空档不会「等着重新指向组档」：固化是显式意图，重开开关也不自动复活继承
  const zoeGrouped = await createUser("verifyzoeg");
  await patchUser(zoeGrouped.id, { inherit_group_periods: false });
  await patchUser(zoeGrouped.id, { period_cycles: [{ seconds: DAY, quota_tokens: null, quota_requests: null }] });
  const zoeGroupedDay = parsePeriodCycles((await storedUser(zoeGrouped.id)).period_cycles).find((c) => c.seconds === DAY);
  check("S57 组有同周期档位时关闭继承提交的留空档仍固化成 -1", zoeGroupedDay?.quota_requests === -1 && zoeGroupedDay?.quota_tokens === -1, JSON.stringify(zoeGroupedDay));
  const zoeGroupedOn = await patchUser(zoeGrouped.id, { inherit_group_periods: true });
  const zoeGroupedQuota = await checkQuota(zoeGrouped.id, 0);
  check("S58 重新打开开关不把固化的 -1 自动恢复成继承", zoeGroupedOn.status === 200 && zoeGroupedQuota.quota.periods.find((p) => p.period_seconds === DAY)?.quota_requests === -1, JSON.stringify(zoeGroupedQuota.quota.periods).slice(0, 200));

  // ---- 关闭继承时不得清空已过量：固化前先推进过期窗口（审计低危 1） ----
  const yuri = await createUser("verifyyuri");
  await db.execute("INSERT INTO `keys` (`key`, name, user_id, enabled) VALUES (?, 'k', ?, 1)", ["verify-yuri-key", yuri.id]);
  const yuriKey = await db.queryOne("SELECT id FROM `keys` WHERE user_id = ?", [yuri.id]);
  await patchUser(yuri.id, { period_cycles: [{ seconds: DAY, quota_tokens: null, quota_requests: null }] });
  await primeWindows(yuri.id);
  await addUsage(yuri.id, yuriKey.id, 0, 3);
  const yuriBefore = parsePeriodCycles((await storedUser(yuri.id)).period_cycles).find((c) => c.seconds === DAY);
  // 锚点未过期：固化后已用量必须原样保留，不能被计数路径当成过期窗口清零
  const yuriOff = await patchUser(yuri.id, { inherit_group_periods: false });
  const yuriAfter = parsePeriodCycles((await storedUser(yuri.id)).period_cycles).find((c) => c.seconds === DAY);
  check("S59 关闭继承后已用量不清零", yuriOff.status === 200 && yuriAfter?.used_requests === yuriBefore.used_requests, "before=" + JSON.stringify(yuriBefore) + " after=" + JSON.stringify(yuriAfter));
  check("S60 关闭继承不重置仍在有效期内的窗口", yuriAfter?.reset_at === yuriBefore.reset_at, "before=" + yuriBefore?.reset_at + " after=" + yuriAfter?.reset_at);
  // 锚点已过期：固化时当场推进窗口，而不是等下一次计费顺手清掉
  await db.execute("UPDATE users SET period_cycles = ? WHERE id = ?", [
    JSON.stringify(parsePeriodCycles((await storedUser(yuri.id)).period_cycles).map((c) => ({ ...c, reset_at: "2000-01-01 00:00:00", used_requests: 9 }))),
    yuri.id,
  ]);
  await patchUser(yuri.id, { inherit_group_periods: true });
  await patchUser(yuri.id, { inherit_group_periods: false });
  const yuriExpired = parsePeriodCycles((await storedUser(yuri.id)).period_cycles).find((c) => c.seconds === DAY);
  check("S61 关闭继承时过期的窗口锚点被推进（不会留到下次计费）", yuriExpired?.reset_at !== "2000-01-01 00:00:00" && yuriExpired?.quota_requests === -1, JSON.stringify(yuriExpired));
  // 已过期窗口的用量在推进时被清零，属于「窗口已经换了一轮」的事实，而不是「关闭」动作清掉的。
  // 关键在于：推进后立刻计费不会再清一次，usage 从 0 起算并正常累加。
  check("S61b 过期窗口推进后用量按新窗口从 0 起算", yuriExpired?.used_requests === 0, JSON.stringify(yuriExpired));

  // ---- 关闭继承即清掉 group_period_cycles 残留（审计低危 5） ----
  const xena = await createUser("verifyxena");
  await db.execute("INSERT INTO `keys` (`key`, name, user_id, enabled) VALUES (?, 'k', ?, 1)", ["verify-xena-key", xena.id]);
  const xenaKey = await db.queryOne("SELECT id FROM `keys` WHERE user_id = ?", [xena.id]);
  await primeWindows(xena.id);
  await addUsage(xena.id, xenaKey.id, 0, 2);
  const xenaBefore = await storedUser(xena.id);
  check("S62 关闭继承前继承计数已存在", parsePeriodCycles(xenaBefore.group_period_cycles).length > 0, "group_period_cycles=" + xenaBefore.group_period_cycles);
  // 关闭后不再产生用量：残留计数必须已经清掉，不能依赖「下一次计费」
  const xenaOff = await patchUser(xena.id, { inherit_group_periods: false });
  const xenaAfter = await storedUser(xena.id);
  check("S63 关闭继承当次就清掉 group_period_cycles 残留", xenaOff.status === 200 && xenaAfter.group_period_cycles === null, "before=" + xenaBefore.group_period_cycles + " after=" + xenaAfter.group_period_cycles);
  // 只改别的字段不能顺手清计数（避免把「无关编辑」变成隐式重置）
  await patchUser(xena.id, { inherit_group_periods: true });
  await primeWindows(xena.id);
  await addUsage(xena.id, xenaKey.id, 0, 2);
  await patchUser(xena.id, { note: "只改备注" });
  check("S64 只改其它字段不清 group_period_cycles", (await storedUser(xena.id)).group_period_cycles !== null, "group_period_cycles=" + (await storedUser(xena.id)).group_period_cycles);
  // 同一次提交里既关开关又改档位：残留计数同样要清
  const xenaCombo = await patchUser(xena.id, {
    inherit_group_periods: false,
    period_cycles: [{ seconds: DAY, quota_tokens: 7, quota_requests: 7 }],
  });
  const xenaComboRow = await storedUser(xena.id);
  check("S64b 同时关开关并提交档位也清掉 group_period_cycles", xenaCombo.status === 200 && xenaComboRow.group_period_cycles === null, "group_period_cycles=" + xenaComboRow.group_period_cycles);
  check("S64c 同时提交的档位按提交形状落库", parsePeriodCycles(xenaComboRow.period_cycles).find((c) => c.seconds === DAY)?.quota_requests === 7, "period_cycles=" + xenaComboRow.period_cycles);
  // reset_usage 分支在事务之后重新读库，与本次新增的清计数不能互相打架
  const xenaReset = await patchUser(xena.id, { inherit_group_periods: false, reset_usage: "period" });
  const xenaResetRow = await storedUser(xena.id);
  // reset_at 被置为 null 是重置的中间态：下一次读取（响应里的 resolveEffectivePeriods）会正常开窗并回填锚点，
  // 因此这里只断言「用量归零且残留计数已清」，不断言锚点形态。
  check("S64d 同一次提交里 reset_usage 与关闭开关共存", xenaReset.status === 200 && xenaResetRow.group_period_cycles === null && parsePeriodCycles(xenaResetRow.period_cycles).every((c) => c.used_requests === 0 && c.used_tokens === 0), "group=" + xenaResetRow.group_period_cycles + " period=" + xenaResetRow.period_cycles);

  // ---- /api/dashboard/profile 与 /api/user/quota 的 periods 形状一致（审计低危 4） ----
  const profileRoute = await import("@/app/api/dashboard/profile/route");
  const walter = await createUser("verifywalter");
  await patchUser(walter.id, { inherit_group_periods: false });
  const walterProfile = await (await profileRoute.GET(userRequest("/api/dashboard/profile", walter.id))).json();
  const walterQuota = await (await userQuotaRoute.GET(userRequest("/api/user/quota", walter.id))).json();
  const profileShape = (walterProfile.user?.periods ?? []).map((p) => p.period_seconds + ":" + p.quota_requests).sort();
  const quotaShape = (walterQuota.periods ?? []).map((p) => p.period_seconds + ":" + p.quota_requests).sort();
  check("S65 profile 与 user/quota 的 periods 形状一致", JSON.stringify(profileShape) === JSON.stringify(quotaShape), "profile=" + JSON.stringify(profileShape) + " quota=" + JSON.stringify(quotaShape));
  check("S66 profile 的 periods 含未配置占位档", profileShape.some((entry) => entry.startsWith("2592000:")), JSON.stringify(profileShape));

  // ---- 生效档位里同秒数只能有一条（判定/响应头/前端 key 都按它分组） ----
  // 用户两侧留空 + 组档有额度时，自有档那条与继承档那条曾同时在 all 里出现：
  // 判定各算一遍、响应头按 id 写出两份互相冲突的值、前端列表撞 key。
  await setGroupCycles(G, [{ seconds: DAY, quota_requests: 30, quota_tokens: null }]);
  const xavi = await createUser("verifyxavi");
  await patchUser(xavi.id, { period_cycles: [{ seconds: DAY, quota_tokens: null, quota_requests: null }] });
  const xaviQuota = await checkQuota(xavi.id, 0);
  const xaviDay = xaviQuota.quota.periods.filter((p) => p.period_seconds === DAY);
  check("S67 生效档位里同秒数只有一条", xaviDay.length === 1, JSON.stringify(xaviQuota.quota.periods.map((p) => [p.period_seconds, p.id])));
  // 生效值必须来自组档（30），不能是自有档那条的 -1（留空被落成 -1 的残留）
  check("S68 同秒数那条取组档额度", xaviDay[0]?.quota_requests === 30, JSON.stringify(xaviDay));
  const xaviHeaders = {};
  appendQuotaHeaders(xaviHeaders, { remaining_requests: null, remaining_tokens: null, periods: xaviQuota.quota.periods });
  const xaviDayHeaders = Object.keys(xaviHeaders).filter((key) => key.startsWith("X-Period-Quota-Requests-Remaining-") && key.includes("p1"));
  check("S69 同秒数只写一份周期余量头", xaviDayHeaders.length === 1, JSON.stringify(xaviHeaders));

  // ---- -1 切回留空：遗留的 used_* 不能压住新的组档额度 ----
  const yves = await createUser("verifyyves");
  await db.execute("INSERT INTO `keys` (`key`, name, user_id, enabled) VALUES (?, 'k', ?, 1)", ["verify-yves-key", yves.id]);
  const yvesKey = await db.queryOne("SELECT id FROM `keys` WHERE user_id = ?", [yves.id]);
  await patchUser(yves.id, { period_cycles: [{ seconds: DAY, quota_tokens: -1, quota_requests: -1 }] });
  for (let i = 0; i < 5; i += 1) {
    await primeWindows(yves.id);
    await addUsage(yves.id, yvesKey.id, 0, 1);
  }
  const yvesUnlimited = await checkQuota(yves.id, 0);
  check("S70 -1 档累积用量后仍放行", yvesUnlimited.ok === true, JSON.stringify(yvesUnlimited).slice(0, 160));
  // 切回留空 = 这一档交回组档（组档额度 30），已用 5 次的历史用量不该继续压着
  await patchUser(yves.id, { period_cycles: [{ seconds: DAY, quota_tokens: null, quota_requests: null }] });
  const yvesBack = await checkQuota(yves.id, 0);
  const yvesDay = yvesBack.quota.periods.find((p) => p.period_seconds === DAY);
  check("S71 切回留空后用量从组档重新起算", yvesBack.ok === true && yvesDay?.quota_requests === 30 && yvesDay?.used_requests === 0, JSON.stringify(yvesDay));
  await primeWindows(yves.id);
  await addUsage(yves.id, yvesKey.id, 0, 1);
  const yvesStored = await storedUser(yves.id);
  check("S72 切回留空后计费写继承档计数", dayCycles(yvesStored.group_period_cycles)[0]?.used_requests === 1, "group_period_cycles=" + yvesStored.group_period_cycles);

  // ---- 跨侧覆盖：一侧自有额度、另一侧沿用组档，两条键空间的计数必须都进判定 ----
  // 组只限每日请求、用户只填每日 Token 时，请求用量记在 group_period_cycles、
  // Token 用量记在 period_cycles。判定若只读自有档那份，组档限额就永远拦不住。
  await setGroupCycles(G, [{ seconds: DAY, quota_tokens: null, quota_requests: 5 }]);
  const zack = await createUser("verifyzack");
  await db.execute("INSERT INTO `keys` (`key`, name, user_id, enabled) VALUES (?, 'k', ?, 1)", ["verify-zack-key", zack.id]);
  const zackKey = await db.queryOne("SELECT id FROM `keys` WHERE user_id = ?", [zack.id]);
  await setUserCycles(zack.id, [{ seconds: DAY, quota_tokens: 100000, quota_requests: null }]);
  for (let i = 0; i < 5; i += 1) {
    await primeWindows(zack.id);
    await addUsage(zack.id, zackKey.id, 10, 1);
  }
  const zackQuota = await checkQuota(zack.id, 0);
  const zackDay = zackQuota.quota.periods.filter((p) => p.period_seconds === DAY);
  check("S73 跨侧覆盖时判定读得到组档请求用量", zackDay.length === 1 && zackDay[0]?.used_requests === 5, JSON.stringify(zackDay));
  check("S74 跨侧覆盖时组档请求额度仍能拦住", zackQuota.ok === false && String(zackQuota.reason).includes("周期请求配额已用尽"), JSON.stringify(zackQuota).slice(0, 200));

  // ---- 交回组档：留空攒量 -> -1 -> 切回留空，两套键空间的旧计数都不能复活 ----
  await setGroupCycles(G, [{ seconds: DAY, quota_tokens: null, quota_requests: 100 }]);
  const zara = await createUser("verifyzara");
  await db.execute("INSERT INTO `keys` (`key`, name, user_id, enabled) VALUES (?, 'k', ?, 1)", ["verify-zara-key", zara.id]);
  const zaraKey = await db.queryOne("SELECT id FROM `keys` WHERE user_id = ?", [zara.id]);
  await patchUser(zara.id, { period_cycles: [{ seconds: DAY, quota_tokens: null, quota_requests: null }] });
  for (let i = 0; i < 3; i += 1) {
    await primeWindows(zara.id);
    await addUsage(zara.id, zaraKey.id, 0, 1);
  }
  await patchUser(zara.id, { period_cycles: [{ seconds: DAY, quota_tokens: -1, quota_requests: -1 }] });
  for (let i = 0; i < 2; i += 1) {
    await primeWindows(zara.id);
    await addUsage(zara.id, zaraKey.id, 0, 1);
  }
  await patchUser(zara.id, { period_cycles: [{ seconds: DAY, quota_tokens: null, quota_requests: null }] });
  const zaraAfter = await storedUser(zara.id);
  check("S75 切回留空时清掉继承档旧计数", zaraAfter.group_period_cycles === null, "group_period_cycles=" + zaraAfter.group_period_cycles);
  const zaraQuota = await checkQuota(zara.id, 0);
  check("S76 切回留空后判定从 0 起算", zaraQuota.quota.periods.find((p) => p.period_seconds === DAY)?.used_requests === 0, JSON.stringify(zaraQuota.quota.periods.filter((p) => p.period_seconds === DAY)));
  await primeWindows(zara.id);
  await addUsage(zara.id, zaraKey.id, 0, 1);
  const zaraStored = await storedUser(zara.id);
  const zaraGroupUsed = parsePeriodCycles(zaraStored.group_period_cycles).find((c) => c.seconds === DAY)?.used_requests;
  check("S77 切回留空后计费写继承档且不复用历史用量", zaraGroupUsed === 1, "group_period_cycles=" + zaraStored.group_period_cycles);
  const zaraQuotaAfter = await checkQuota(zara.id, 0);
  check("S78 切回留空后判定与计费同口径", zaraQuotaAfter.quota.periods.find((p) => p.period_seconds === DAY)?.used_requests === zaraGroupUsed, JSON.stringify(zaraQuotaAfter.quota.periods.filter((p) => p.period_seconds === DAY)) + " group=" + zaraGroupUsed);

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

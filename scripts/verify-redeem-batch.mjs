// 验证兑换码按批次查询、停用（召回）、重新启用与删除，以及批次筛选与三选一校验。
// 真实链路：临时 SQLite 库 + 真实 DB 初始化 + 真实服务层 + 真实 admin 路由。
// 运行：node scripts/verify-redeem-batch.mjs（脚本会自举 --experimental-transform-types 并自注册别名 loader）
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
const sandbox = mkdtempSync(path.join(tmpdir(), "redeem-batch-verify-"));
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
const loaderPath = path.join(sandbox, "verify-redeem-batch-loader.mjs");
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

let db = null;
try {
  const { ensureDbReady } = await import("@/lib/core/db");
  db = await ensureDbReady();

  const svc = await import("@/lib/services/redeem-codes");
  const { listRedeemScopes } = await import("@/lib/services/redeem-authorization");
  const { signAccessToken } = await import("@/lib/auth/auth");
  const adminRoute = await import("@/app/api/admin/redeem-codes/route");
  const { formatBatchLabel } = await import("@/app/dashboard/redeem-codes/redeem-code-types");
  const bcrypt = (await import("bcryptjs")).default;

  const defaultGroup = await db.queryOne("SELECT id FROM `groups` WHERE is_default = 1 AND deleted_at IS NULL");
  const groupId = defaultGroup.id;
  const hash = await bcrypt.hash("Verify1234", 4);

  const userInsert = await db.execute(
    "INSERT INTO users (username, password_hash, role, group_id, rpm, qps, tpm, enabled) VALUES (?, ?, 'user', ?, -1, -1, -1, 1)",
    ["verifybatchuser", hash, groupId],
  );
  const userId = userInsert.lastInsertRowid;

  const adminInsert = await db.execute(
    "INSERT INTO users (username, password_hash, role, group_id, rpm, qps, tpm, enabled) VALUES (?, ?, 'admin', ?, -1, -1, -1, 1)",
    ["verifybatchadmin", hash, groupId],
  );
  const adminRow = await db.queryOne("SELECT id, username, role, token_version FROM users WHERE id = ?", [adminInsert.lastInsertRowid]);
  adminToken = signAccessToken(adminRow);

  async function generate(count, extra = {}) {
    return adminRoute.POST(adminRequest("/api/admin/redeem-codes", "POST", {
      count,
      kind: "quota",
      token_quota: 1000,
      max_uses: 5,
      ...extra,
    }));
  }

  const genA = await generate(2, { note: "批次 A" });
  const genABody = await genA.json();
  const batchA = genABody.data?.batch_id ?? "";
  const codesA = Array.isArray(genABody.data?.codes) ? genABody.data.codes : [];
  check("B1 生成批次 A 返回 201、2 个码和 batch_id", genA.status === 201 && codesA.length === 2 && typeof batchA === "string" && batchA.length > 0, `status=${genA.status} n=${codesA.length} batch=${batchA}`);
  if (!batchA || codesA.length !== 2) throw new Error("批次 A 生成结果不完整，后续用例无法继续");

  const genB = await generate(1);
  const genBBody = await genB.json();
  const batchB = genBBody.data?.batch_id ?? "";
  const codesB = Array.isArray(genBBody.data?.codes) ? genBBody.data.codes : [];
  check("B2 生成批次 B 返回 201、1 个码和 batch_id", genB.status === 201 && codesB.length === 1 && typeof batchB === "string" && batchB.length > 0, `status=${genB.status} n=${codesB.length} batch=${batchB}`);
  if (!batchB || codesB.length !== 1) throw new Error("批次 B 生成结果不完整，后续用例无法继续");

  const genC = await generate(501, { token_quota: 100, max_uses: 1 });
  const genCBody = await genC.json();
  const batchC = genCBody.data?.batch_id ?? "";
  const codesC = Array.isArray(genCBody.data?.codes) ? genCBody.data.codes : [];
  check("B3 生成 501 个码的批次 C", genC.status === 201 && codesC.length === 501 && typeof batchC === "string" && batchC.length > 0, `status=${genC.status} n=${codesC.length} batch=${batchC}`);
  if (!batchC || codesC.length !== 501) throw new Error("批次 C 生成结果不完整，后续用例无法继续");

  const listA = await adminRoute.GET(adminRequest(`/api/admin/redeem-codes?batch_id=${encodeURIComponent(batchA)}&limit=100`, "GET"));
  const listABody = await listA.json();
  check("B4 列表按 batch_id 精确筛选", listA.status === 200 && listABody.paging?.total === 2 && listABody.data?.length === 2 && listABody.data.every((row) => row.batch_id === batchA), `status=${listA.status} total=${listABody.paging?.total}`);

  const listAByKeyword = await adminRoute.GET(adminRequest(`/api/admin/redeem-codes?batch_id=${encodeURIComponent(batchA)}&keyword=${encodeURIComponent(codesA[0])}&limit=100`, "GET"));
  const listAByKeywordBody = await listAByKeyword.json();
  check("B4b 批次与关键字可叠加筛选", listAByKeyword.status === 200 && listAByKeywordBody.paging?.total === 1 && listAByKeywordBody.data?.[0]?.code === codesA[0], `status=${listAByKeyword.status} total=${listAByKeywordBody.paging?.total}`);

  const redeemA1 = await svc.redeemCodeForUser(userId, codesA[0]);
  check("B5 批次 A 的兑换码可正常兑换", redeemA1.ok === true, JSON.stringify(redeemA1).slice(0, 200));
  const balancesActive = await svc.listUserBalances(userId);
  check("B6 兑换后定向额度有效", balancesActive.length === 1 && balancesActive[0].active === true, JSON.stringify(balancesActive[0]?.inactive_reason));
  const scopesActive = await listRedeemScopes(userId);
  const matchActive = await svc.findMatchingRedeemBalance(userId, 1, "verify-any-alias");
  check("B6b 兑换后授权区域与计费命中正常", scopesActive.length === 1 && matchActive !== null, `scopes=${scopesActive.length} match=${matchActive ? "hit" : "miss"}`);

  const disableA = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { batch_id: batchA, enabled: false }));
  const disableABody = await disableA.json();
  check("B7 按批次停用返回 200 且数量为整批", disableA.status === 200 && disableABody.message === "已停用 2 个兑换码。", `status=${disableA.status} msg=${disableABody.message}`);

  const disableARepeat = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { batch_id: batchA, enabled: false }));
  const disableARepeatBody = await disableARepeat.json();
  check("B7b 重复停用已停用批次仍返回 200 且数量为整批", disableARepeat.status === 200 && disableARepeatBody.message === "已停用 2 个兑换码。", `status=${disableARepeat.status} msg=${disableARepeatBody.message}`);

  const aRows = await db.query("SELECT id, enabled FROM redeem_codes WHERE batch_id = ?", [batchA]);
  const bRow = await db.queryOne("SELECT enabled FROM redeem_codes WHERE batch_id = ?", [batchB]);
  check("B8 批次 A 全部停用且批次 B 不受影响", aRows.length === 2 && aRows.every((row) => row.enabled === 0) && bRow.enabled === 1, JSON.stringify({ a: aRows, b: bRow }));

  const redeemDisabled = await svc.redeemCodeForUser(userId, codesA[1]);
  check("B9 停用后未兑换的码被拒", redeemDisabled.ok === false && redeemDisabled.reason === "该兑换码已停用", JSON.stringify(redeemDisabled).slice(0, 200));

  const balancesDisabled = await svc.listUserBalances(userId);
  check("B10 停用后已发放额度失效（召回生效）", balancesDisabled.length === 1 && balancesDisabled[0].active === false && balancesDisabled[0].inactive_reason === "兑换码已停用", JSON.stringify(balancesDisabled[0]?.inactive_reason));
  const scopesDisabled = await listRedeemScopes(userId);
  const matchDisabled = await svc.findMatchingRedeemBalance(userId, 1, "verify-any-alias");
  check("B10b 停用后授权区域被回收", scopesDisabled.length === 0, "scopes=" + scopesDisabled.length);
  check("B10c 停用后计费侧不再命中额度", matchDisabled === null, matchDisabled ? "hit" : "miss");

  const enableA = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { batch_id: batchA, enabled: true }));
  const enableABody = await enableA.json();
  check("B11 按批次重新启用返回 200", enableA.status === 200 && enableABody.message === "已启用 2 个兑换码。", `status=${enableA.status} msg=${enableABody.message}`);

  const enableARepeat = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { batch_id: batchA, enabled: true }));
  const enableARepeatBody = await enableARepeat.json();
  check("B11b 重复启用已启用批次仍返回 200 且数量为整批", enableARepeat.status === 200 && enableARepeatBody.message === "已启用 2 个兑换码。", `status=${enableARepeat.status} msg=${enableARepeatBody.message}`);

  const balancesRestored = await svc.listUserBalances(userId);
  check("B12 重新启用后已发放额度恢复", balancesRestored.length === 1 && balancesRestored[0].active === true, JSON.stringify(balancesRestored[0]?.inactive_reason));
  const scopesRestored = await listRedeemScopes(userId);
  const matchRestored = await svc.findMatchingRedeemBalance(userId, 1, "verify-any-alias");
  check("B12b 重新启用后授权区域恢复", scopesRestored.length === 1, "scopes=" + scopesRestored.length);
  check("B12c 重新启用后计费侧重新命中额度", matchRestored !== null, matchRestored ? "hit" : "miss");

  const redeemA2 = await svc.redeemCodeForUser(userId, codesA[1]);
  check("B13 重新启用后可继续兑换", redeemA2.ok === true, JSON.stringify(redeemA2).slice(0, 200));

  const redeemB = await svc.redeemCodeForUser(userId, codesB[0]);
  check("B13b 批次 B 的码可兑换（用于删除隔离验证）", redeemB.ok === true, JSON.stringify(redeemB).slice(0, 200));

  const beforeDelete = await db.queryOne(
    `SELECT
       (SELECT COUNT(*) FROM redeem_codes WHERE batch_id = ?) AS codes,
       (SELECT COUNT(*) FROM redeem_balances WHERE code_id IN (SELECT id FROM redeem_codes WHERE batch_id = ?)) AS balances,
       (SELECT COUNT(*) FROM redeem_redemptions WHERE code_id IN (SELECT id FROM redeem_codes WHERE batch_id = ?)) AS redemptions`,
    [batchA, batchA, batchA],
  );
  check("B14 删除前批次 A 有 2 条额度与 2 条核销记录", beforeDelete.codes === 2 && beforeDelete.balances === 2 && beforeDelete.redemptions === 2, JSON.stringify(beforeDelete));

  const deleteA = await adminRoute.DELETE(adminRequest("/api/admin/redeem-codes", "DELETE", { batch_id: batchA }));
  const deleteABody = await deleteA.json();
  check("B15 按批次删除返回 200 且数量为整批", deleteA.status === 200 && deleteABody.message === "已删除 2 个兑换码。", `status=${deleteA.status} msg=${deleteABody.message}`);

  const afterDelete = await db.queryOne(
    `SELECT
       (SELECT COUNT(*) FROM redeem_codes WHERE batch_id = ?) AS codes,
       (SELECT COUNT(*) FROM redeem_balances WHERE code_id IN (SELECT id FROM redeem_codes WHERE batch_id = ?)) AS balances,
       (SELECT COUNT(*) FROM redeem_redemptions WHERE code_id IN (SELECT id FROM redeem_codes WHERE batch_id = ?)) AS redemptions`,
    [batchA, batchA, batchA],
  );
  check("B16 删除后批次 A 的码、额度、核销记录全部清除", afterDelete.codes === 0 && afterDelete.balances === 0 && afterDelete.redemptions === 0, JSON.stringify(afterDelete));
  check("B17 其他批次 B 保留", (await db.queryOne("SELECT COUNT(*) AS n FROM redeem_codes WHERE batch_id = ?", [batchB])).n === 1, "");

  const bCounts = await db.queryOne(
    `SELECT
       (SELECT COUNT(*) FROM redeem_codes WHERE batch_id = ?) AS codes,
       (SELECT COUNT(*) FROM redeem_balances WHERE code_id IN (SELECT id FROM redeem_codes WHERE batch_id = ?)) AS balances,
       (SELECT COUNT(*) FROM redeem_redemptions WHERE code_id IN (SELECT id FROM redeem_codes WHERE batch_id = ?)) AS redemptions`,
    [batchB, batchB, batchB],
  );
  check("B17b 删除批次 A 不影响批次 B 的额度与核销记录", bCounts.codes === 1 && bCounts.balances === 1 && bCounts.redemptions === 1, JSON.stringify(bCounts));

  const disableC = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { batch_id: batchC, enabled: false }));
  const disableCBody = await disableC.json();
  check("B18 501 个码的批次一次停用（不受 500 上限约束）", disableC.status === 200 && disableCBody.message === "已停用 501 个兑换码。", `status=${disableC.status} msg=${disableCBody.message}`);
  const cDisabled = await db.queryOne("SELECT COUNT(*) AS n FROM redeem_codes WHERE batch_id = ? AND enabled = 0", [batchC]);
  check("B19 批次 C 全部停用", cDisabled.n === 501, "n=" + cDisabled.n);

  const deleteC = await adminRoute.DELETE(adminRequest("/api/admin/redeem-codes", "DELETE", { batch_id: batchC }));
  const deleteCBody = await deleteC.json();
  check("B20 501 个码的批次一次删除", deleteC.status === 200 && deleteCBody.message === "已删除 501 个兑换码。", `status=${deleteC.status} msg=${deleteCBody.message}`);
  check("B21 批次 C 已清空", (await db.queryOne("SELECT COUNT(*) AS n FROM redeem_codes WHERE batch_id = ?", [batchC])).n === 0, "");

  const mixedPut = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { codes: [codesB[0]], batch_id: batchB, enabled: false }));
  check("B22 PUT 同时传 codes 与 batch_id 返回 400", mixedPut.status === 400, "status=" + mixedPut.status);
  const mixedDelete = await adminRoute.DELETE(adminRequest("/api/admin/redeem-codes", "DELETE", { code: codesB[0], batch_id: batchB }));
  check("B23 DELETE 同时传 code 与 batch_id 返回 400", mixedDelete.status === 400, "status=" + mixedDelete.status);

  const missingPut = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { batch_id: "missing-batch", enabled: false }));
  const missingPutBody = await missingPut.json();
  check("B24 不存在的批次停用返回 404 批次不存在", missingPut.status === 404 && missingPutBody.error?.message === "批次不存在", `status=${missingPut.status} msg=${missingPutBody.error?.message}`);
  const missingDelete = await adminRoute.DELETE(adminRequest("/api/admin/redeem-codes", "DELETE", { batch_id: "missing-batch" }));
  check("B25 不存在的批次删除返回 404", missingDelete.status === 404, "status=" + missingDelete.status);

  const longBatch = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { batch_id: "x".repeat(65), enabled: false }));
  check("B26 超长 batch_id 返回 400", longBatch.status === 400, "status=" + longBatch.status);
  const maxBatch = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { batch_id: "x".repeat(64), enabled: false }));
  const maxBatchBody = await maxBatch.json();
  check("B26b 64 字符 batch_id 通过长度校验（返回 404 批次不存在）", maxBatch.status === 404 && maxBatchBody.error?.message === "批次不存在", `status=${maxBatch.status} msg=${maxBatchBody.error?.message}`);

  const listMissing = await adminRoute.GET(adminRequest("/api/admin/redeem-codes?batch_id=missing-batch", "GET"));
  const listMissingBody = await listMissing.json();
  check("B27 不存在的批次筛选返回空列表", listMissing.status === 200 && listMissingBody.paging?.total === 0, `status=${listMissing.status} total=${listMissingBody.paging?.total}`);
  check("B28 批次 B 未被误删或误停", (await db.queryOne("SELECT enabled FROM redeem_codes WHERE batch_id = ?", [batchB])).enabled === 1, "");

  const singleOff = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { code: codesB[0], enabled: false }));
  const singleOn = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { code: codesB[0], enabled: true }));
  check("B31 单条 code 启停仍可用", singleOff.status === 200 && singleOn.status === 200 && (await db.queryOne("SELECT enabled FROM redeem_codes WHERE code = ?", [codesB[0]])).enabled === 1, `off=${singleOff.status} on=${singleOn.status}`);
  const missingCode = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { code: "0000-0000-0000", enabled: false }));
  const missingCodeBody = await missingCode.json();
  check("B32 单条不存在的 code 返回 404", missingCode.status === 404 && missingCodeBody.error?.message === "兑换码不存在", `status=${missingCode.status} msg=${missingCodeBody.error?.message}`);
  const codesOff = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { codes: [codesB[0]], enabled: false }));
  const codesOn = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { codes: [codesB[0]], enabled: true }));
  check("B33 codes 批量启停仍可用", codesOff.status === 200 && codesOn.status === 200 && (await db.queryOne("SELECT enabled FROM redeem_codes WHERE code = ?", [codesB[0]])).enabled === 1, `off=${codesOff.status} on=${codesOn.status}`);
  const ghostCodes = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { codes: ["0000-0000-0000"], enabled: false }));
  const ghostCodesBody = await ghostCodes.json();
  check("B34 codes 批量不存在的码被忽略", ghostCodes.status === 200 && ghostCodesBody.message === "已停用 0 个兑换码。", `status=${ghostCodes.status} msg=${ghostCodesBody.message}`);

  const emptyCodesWithBatch = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { codes: [], batch_id: batchB, enabled: true }));
  const emptyCodesWithBatchBody = await emptyCodesWithBatch.json();
  check("B35 codes 空数组与 batch_id 组合按未传处理", emptyCodesWithBatch.status === 200 && emptyCodesWithBatchBody.message === "已启用 1 个兑换码。", `status=${emptyCodesWithBatch.status} msg=${emptyCodesWithBatchBody.message}`);
  const blankTargets = await adminRoute.PUT(adminRequest("/api/admin/redeem-codes", "PUT", { codes: [], code: "   ", batch_id: "   ", enabled: false }));
  check("B36 空白目标视为未传并返回 400", blankTargets.status === 400, "status=" + blankTargets.status);

  const label = formatBatchLabel("1725000000000-a1b2c3d4");
  check("B29 批次标签为可读时间 + 短后缀", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} · a1b2c3d4$/.test(label), label);
  check("B30 非标准批次号原样展示", formatBatchLabel("legacy-batch") === "legacy-batch", formatBatchLabel("legacy-batch"));

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

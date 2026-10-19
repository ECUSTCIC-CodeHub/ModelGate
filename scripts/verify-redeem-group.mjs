// 验证兑换码用户组白名单与批量上限（t1 契约 C30，G1–G7）。
// 真实链路：临时 SQLite 库 + 真实 DB 初始化 + 真实服务层 + 真实 admin 路由。
// 运行：node scripts/verify-redeem-group.mjs（脚本会自举 --experimental-transform-types 并自注册别名 loader）
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
const sandbox = mkdtempSync(path.join(tmpdir(), "redeem-group-verify-"));
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
const loaderPath = path.join(sandbox, "verify-redeem-group-loader.mjs");
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
  const { signAccessToken } = await import("@/lib/auth/auth");
  const adminRoute = await import("@/app/api/admin/redeem-codes/route");
  const detailRoute = await import("@/app/api/admin/redeem-codes/[id]/route");
  const bcrypt = (await import("bcryptjs")).default;

  async function createUser(username, groupId) {
    const hash = await bcrypt.hash("Verify1234", 4);
    await db.execute(
      "INSERT INTO users (username, password_hash, role, group_id, rpm, qps, tpm, enabled) VALUES (?, ?, 'user', ?, -1, -1, -1, 1)",
      [username, hash, groupId],
    );
    return db.queryOne("SELECT id, username, role, group_id, token_version FROM users WHERE username = ?", [username]);
  }

  const defaultGroup = await db.queryOne("SELECT id FROM \`groups\` WHERE is_default = 1 AND deleted_at IS NULL");
  const G1 = defaultGroup.id;
  await db.execute("INSERT INTO \`groups\` (name, description, qps, rpm, tpm) VALUES ('verify-outsider', '组外用户', -1, -1, -1)");
  const G2 = (await db.queryOne("SELECT id FROM \`groups\` WHERE name = 'verify-outsider'")).id;

  const adminRow = await createUser("verifyadmin", G1);
  await db.execute("UPDATE users SET role = 'admin' WHERE id = ?", [adminRow.id]);
  const admin = await db.queryOne("SELECT id, username, role, token_version FROM users WHERE id = ?", [adminRow.id]);
  adminToken = signAccessToken(admin);

  const insider = await createUser("verifyinsider", G1);
  const outsider = await createUser("verifyoutsider", G2);
  const noGroupUser = await createUser("verifynogroup", null);

  // G1/G2：白名单拒绝与放行
  const gen1 = await adminRoute.POST(adminRequest("/api/admin/redeem-codes", "POST", {
    count: 1, kind: "quota", token_quota: 1000, allowed_group_ids: [G1], max_uses: 5,
  }));
  const gen1Body = await gen1.json();
  const code1 = gen1Body.data?.codes?.[0];
  check("G1a 生成带白名单的兑换码返回 201", gen1.status === 201 && code1, "status=" + gen1.status + " body=" + JSON.stringify(gen1Body).slice(0, 300));

  const denyOutsider = await svc.redeemCodeForUser(outsider.id, code1);
  check("G1b 组外用户兑换被拒", denyOutsider.ok === false, JSON.stringify(denyOutsider).slice(0, 200));
  check("G1c 拒绝文案精确匹配", denyOutsider.ok === false && denyOutsider.reason === "该兑换码仅限指定用户组兑换", denyOutsider.reason);
  const denyNoGroup = await svc.redeemCodeForUser(noGroupUser.id, code1);
  check("G1d 无组用户兑换被拒", denyNoGroup.ok === false && denyNoGroup.reason === "该兑换码仅限指定用户组兑换", JSON.stringify(denyNoGroup).slice(0, 200));
  const row1 = await db.queryOne("SELECT used_count FROM redeem_codes WHERE code = ?", [code1]);
  check("G1e 拒绝后 used_count 不变（=0）", row1.used_count === 0, "used_count=" + row1.used_count);

  const allowInsider = await svc.redeemCodeForUser(insider.id, code1);
  check("G2a 组内用户兑换成功", allowInsider.ok === true, JSON.stringify(allowInsider).slice(0, 200));
  check("G2b 成功时返回额度对象且额度正确", allowInsider.ok === true && allowInsider.balance?.token_quota === 1000, "");

  // G3：缺省与空数组均为不限
  const gen2 = await adminRoute.POST(adminRequest("/api/admin/redeem-codes", "POST", { count: 1, kind: "quota", token_quota: 500, max_uses: 5 }));
  const code2 = (await gen2.json()).data.codes[0];
  const gen3 = await adminRoute.POST(adminRequest("/api/admin/redeem-codes", "POST", { count: 1, kind: "quota", token_quota: 500, allowed_group_ids: [], max_uses: 5 }));
  const code3 = (await gen3.json()).data.codes[0];
  const r21 = await svc.redeemCodeForUser(outsider.id, code2);
  const r31 = await svc.redeemCodeForUser(outsider.id, code3);
  check("G3a 缺省 allowed_group_ids 时组外用户可兑换", r21.ok === true, JSON.stringify(r21).slice(0, 200));
  check("G3b 空数组 allowed_group_ids 时组外用户可兑换", r31.ok === true, JSON.stringify(r31).slice(0, 200));

  // G4：重置券同样受白名单约束
  const gen4 = await adminRoute.POST(adminRequest("/api/admin/redeem-codes", "POST", { count: 1, kind: "reset", allowed_group_ids: [G1], max_uses: 5 }));
  const code4 = (await gen4.json()).data.codes[0];
  const resetDeny = await svc.redeemCodeForUser(outsider.id, code4);
  check("G4a 重置券组外用户被拒", resetDeny.ok === false && resetDeny.reason === "该兑换码仅限指定用户组兑换", JSON.stringify(resetDeny).slice(0, 200));
  const resetAllow = await svc.redeemCodeForUser(insider.id, code4);
  check("G4b 重置券组内用户成功", resetAllow.ok === true && resetAllow.reset === true, JSON.stringify(resetAllow).slice(0, 200));

  // G5：批量上限 1000/1001
  const gen1000 = await adminRoute.POST(adminRequest("/api/admin/redeem-codes", "POST", { count: 1000, kind: "quota", token_quota: 100, max_uses: 1 }));
  const gen1000Body = await gen1000.json();
  check("G5a count=1000 生成成功且实际生成 1000 个", gen1000.status === 201 && gen1000Body.data?.codes?.length === 1000, "status=" + gen1000.status + " n=" + gen1000Body.data?.codes?.length);
  const gen1001 = await adminRoute.POST(adminRequest("/api/admin/redeem-codes", "POST", { count: 1001, kind: "quota", token_quota: 100, max_uses: 1 }));
  const gen1001Body = await gen1001.json();
  check("G5b count=1001 被拒（400 + 请求参数不正确）", gen1001.status === 400 && gen1001Body.error?.message === "请求参数不正确", "status=" + gen1001.status + " msg=" + gen1001Body.error?.message);
  const countRow = await db.queryOne("SELECT COUNT(*) AS n FROM redeem_codes");
  check("G5c 库中兑换码总数与生成一致（1004）", countRow.n === 1004, "n=" + countRow.n);

  // G6：无效组 id 被丢弃并出 warnings（生成 + 编辑）
  const ghostId = 999999;
  const gen6 = await adminRoute.POST(adminRequest("/api/admin/redeem-codes", "POST", {
    count: 1, kind: "quota", token_quota: 100, allowed_group_ids: [ghostId, G1], max_uses: 1,
  }));
  const gen6Body = await gen6.json();
  const code6 = gen6Body.data?.codes?.[0];
  check("G6a 含无效组的生成返回 201 且带 warnings", gen6.status === 201 && Array.isArray(gen6Body.warnings) && gen6Body.warnings.some((w) => w.includes("以下用户组不存在，已忽略")), JSON.stringify(gen6Body.warnings));
  const row6 = await db.queryOne("SELECT allowed_group_ids FROM redeem_codes WHERE code = ?", [code6]);
  check("G6b 生成落库白名单只剩有效组", row6.allowed_group_ids === JSON.stringify([G1]), "stored=" + row6.allowed_group_ids);

  const row6id = await db.queryOne("SELECT id FROM redeem_codes WHERE code = ?", [code6]);
  const patchCtx = { params: Promise.resolve({ id: String(row6id.id) }) };
  const patch6res = await detailRoute.PATCH(adminRequest("/api/admin/redeem-codes/" + row6id.id, "PATCH", { allowed_group_ids: [ghostId, G2] }), patchCtx);
  const patch6Body = await patch6res.json();
  check("G6c PATCH 含无效组返回 200 且带 warnings", patch6res.status === 200 && Array.isArray(patch6Body.warnings) && patch6Body.warnings.some((w) => w.includes("以下用户组不存在，已忽略")), JSON.stringify(patch6Body.warnings));
  check("G6d PATCH 落库白名单只剩有效组", patch6Body.data?.allowed_group_ids === JSON.stringify([G2]), "stored=" + patch6Body.data?.allowed_group_ids);

  // G7：PATCH 传 [] 清空白名单，清空后组外可兑
  const patch7res = await detailRoute.PATCH(adminRequest("/api/admin/redeem-codes/" + row6id.id, "PATCH", { allowed_group_ids: [] }), patchCtx);
  const afterPatch7 = await db.queryOne("SELECT allowed_group_ids FROM redeem_codes WHERE code = ?", [code6]);
  check("G7a PATCH 返回 200 且落库为空数组", patch7res.status === 200 && afterPatch7.allowed_group_ids === "[]", "status=" + patch7res.status + " stored=" + afterPatch7.allowed_group_ids);
  const redeem7 = await svc.redeemCodeForUser(outsider.id, code6);
  check("G7b 清空后组外用户可兑换", redeem7.ok === true, JSON.stringify(redeem7).slice(0, 200));

  // G8（M1/L2 回归）：三类无效项共存时 warnings 三条齐发且顺序稳定；重复无效组只提示一次
  const ghostChannel = 888888;
  const ghostAlias = "verify-ghost-alias";
  const gen8 = await adminRoute.POST(adminRequest("/api/admin/redeem-codes", "POST", {
    count: 1, kind: "quota", token_quota: 100,
    allowed_channel_ids: [ghostChannel], allowed_model_aliases: [ghostAlias],
    allowed_group_ids: [ghostId, ghostId, G1], max_uses: 1,
  }));
  const gen8Body = await gen8.json();
  const w8 = gen8Body.warnings ?? [];
  check("G8a 三类无效项同时存在时 warnings 数组同时包含三类提示", gen8.status === 201 && w8.length === 3, JSON.stringify(w8));
  check("G8b warnings 顺序稳定：渠道 → 别名 → 用户组", w8[0]?.startsWith("以下渠道不存在") === true && w8[1]?.startsWith("以下模型别名不存在") === true && w8[2]?.startsWith("以下用户组不存在") === true, JSON.stringify(w8));
  check("G8c POST 重复无效组 id 只提示一次", w8[2] === `以下用户组不存在，已忽略: ${ghostId}`, w8[2]);
  const row8 = await db.queryOne("SELECT allowed_channel_ids, allowed_model_aliases, allowed_group_ids FROM redeem_codes WHERE code = ?", [gen8Body.data?.codes?.[0]]);
  check("G8d 无效项过滤后落库字段行为不变", row8.allowed_channel_ids === "[]" && row8.allowed_model_aliases === "[]" && row8.allowed_group_ids === JSON.stringify([G1]), JSON.stringify(row8));

  // G9（L2 回归，PATCH 端点）：重复无效组同样只提示一次，与 POST 行为一致
  const patch9res = await detailRoute.PATCH(adminRequest("/api/admin/redeem-codes/" + row6id.id, "PATCH", { allowed_group_ids: [ghostId, ghostId, G2] }), patchCtx);
  const patch9Body = await patch9res.json();
  check("G9a PATCH 重复无效组 id 只提示一次（与 POST 一致）", patch9res.status === 200 && patch9Body.warnings?.length === 1 && patch9Body.warnings[0] === `以下用户组不存在，已忽略: ${ghostId}`, JSON.stringify(patch9Body.warnings));

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

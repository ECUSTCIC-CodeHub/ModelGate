// 运行时验证分时倍率的逐层覆盖口径：模型档优先、渠道档只补模型留空的维度。
// 直接驱动 lib/gateway/multiplier-schedule.ts，不依赖数据库与 Next 运行时。
//
// 运行：
//   node --loader ./scripts/verify-channel-quota-mode-loader.mjs scripts/verify-multiplier-layering.mjs
import assert from "node:assert/strict";
import {
  parseMultiplierSchedules,
  resolveLayeredMultiplier,
  validateMultiplierSchedules,
} from "@/lib/gateway/multiplier-schedule";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`场景 ${name}: OK`);
  } catch (error) {
    failed += 1;
    console.error(`场景 ${name}: FAIL`, error.message);
  }
}

// 2026-11-20 是周五（day=5），10:00 UTC
const friday10 = new Date("2026-11-20T10:00:00Z");
// 2026-11-21 是周六（day=6），10:00 UTC
const saturday10 = new Date("2026-11-21T10:00:00Z");

// 渠道档：周五全天 token 0.5、request 留空；模型档按场景各自构造
const channelWeekday = { days: [5], start: "00:00", end: "12:00", token_multiplier: 0.5, request_multiplier: null };
const channelWeekdayBoth = { days: [5], start: "00:00", end: "12:00", token_multiplier: 0.5, request_multiplier: 3 };
// 模型档：只填 token
const modelTokenOnly = { days: [5], start: "00:00", end: "12:00", token_multiplier: 0.2, request_multiplier: null };
// 模型档：两个维度都填
const modelBoth = { days: [5], start: "00:00", end: "12:00", token_multiplier: 0.2, request_multiplier: 2 };

check("两层都未命中回退基础倍率", () => {
  const r = resolveLayeredMultiplier(2, 4, [[], []], saturday10);
  assert.deepEqual(r, { token_multiplier: 2, request_multiplier: 4, schedule_applied: false });
});

check("只有渠道档命中：覆盖基础倍率", () => {
  const r = resolveLayeredMultiplier(2, 4, [[], [channelWeekday]], friday10);
  assert.equal(r.token_multiplier, 0.5);
  assert.equal(r.request_multiplier, 4);
  assert.equal(r.schedule_applied, true);
});

check("模型档与渠道档都命中：模型档维度优先", () => {
  const r = resolveLayeredMultiplier(2, 4, [[modelBoth], [channelWeekdayBoth]], friday10);
  assert.equal(r.token_multiplier, 0.2);
  assert.equal(r.request_multiplier, 2);
  assert.equal(r.schedule_applied, true);
});

check("模型档留空维度由渠道档补上", () => {
  const r = resolveLayeredMultiplier(2, 4, [[modelTokenOnly], [channelWeekdayBoth]], friday10);
  assert.equal(r.token_multiplier, 0.2);
  assert.equal(r.request_multiplier, 3);
  assert.equal(r.schedule_applied, true);
});

check("模型档留空的维度在渠道档也留空时沿用基础倍率", () => {
  const r = resolveLayeredMultiplier(2, 4, [[modelTokenOnly], [channelWeekday]], friday10);
  assert.equal(r.token_multiplier, 0.2);
  assert.equal(r.request_multiplier, 4);
  assert.equal(r.schedule_applied, true);
});

check("渠道档命中但模型档未命中：渠道档照常生效", () => {
  // 周六两档都不命中；换一个模型档限定周五的场景即可验证「模型档不影响渠道档命中」
  const modelWeekend = { days: [6], start: "00:00", end: "12:00", token_multiplier: 0.1, request_multiplier: null };
  const r = resolveLayeredMultiplier(2, 4, [[modelWeekend], [channelWeekday]], friday10);
  assert.equal(r.token_multiplier, 0.5);
  assert.equal(r.request_multiplier, 4);
  assert.equal(r.schedule_applied, true);
});

check("多层都没有档位时 applied 为 false", () => {
  const r = resolveLayeredMultiplier(1, 1, [[], []], friday10);
  assert.equal(r.schedule_applied, false);
});

check("跨零点窗口的凌晨段归属前一日", () => {
  const crossMidnight = { days: [5], start: "22:00", end: "06:00", token_multiplier: 0.3, request_multiplier: null };
  const saturday2 = new Date("2026-11-21T02:00:00Z");
  assert.equal(resolveLayeredMultiplier(1, 1, [[], [crossMidnight]], saturday2).token_multiplier, 0.3);
  const sunday2 = new Date("2026-11-22T02:00:00Z");
  assert.equal(resolveLayeredMultiplier(1, 1, [[], [crossMidnight]], sunday2).token_multiplier, 1);
});

check("同一层多档命中取第一档", () => {
  const first = { days: [5], start: "00:00", end: "12:00", token_multiplier: 0.4, request_multiplier: null };
  const second = { days: [5], start: "00:00", end: "12:00", token_multiplier: 0.9, request_multiplier: null };
  assert.equal(resolveLayeredMultiplier(1, 1, [[first, second]], friday10).token_multiplier, 0.4);
});

check("解析脏数据不抛错，非法档位被丢弃", () => {
  assert.deepEqual(parseMultiplierSchedules("not json"), []);
  assert.deepEqual(parseMultiplierSchedules(null), []);
  const ok = parseMultiplierSchedules(JSON.stringify([modelTokenOnly, { days: [], start: "x", end: "y" }]));
  assert.equal(ok.length, 1);
});

check("校验接口接受合法的渠道级配置", () => {
  const r = validateMultiplierSchedules([modelTokenOnly]);
  assert.equal(r.valid, true);
  assert.equal(r.schedules.length, 1);
});

check("校验接口拒绝维度全空的档位", () => {
  const r = validateMultiplierSchedules([{ days: [1], start: "00:00", end: "08:00", token_multiplier: null, request_multiplier: null }]);
  assert.equal(r.valid, false);
});

check("null 清空语义", () => {
  const r = validateMultiplierSchedules(null);
  assert.equal(r.valid, true);
  assert.deepEqual(r.schedules, []);
});

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);

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
import { describeAggregatedScheduleSource, describeScheduleSource } from "@/lib/shared/multiplier-source";

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
  assert.deepEqual(r, {
    token_multiplier: 2,
    request_multiplier: 4,
    schedule_applied: false,
    token_source: null,
    request_source: null,
    token_schedule_index: null,
    request_schedule_index: null,
  });
});

check("只有渠道档命中：覆盖基础倍率", () => {
  const r = resolveLayeredMultiplier(2, 4, [[], [channelWeekday]], friday10);
  assert.equal(r.token_source, 1);
  assert.equal(r.request_source, null);
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
  // token 来自模型档（第 0 层），request 来自渠道档（第 1 层）
  assert.equal(r.token_source, 0);
  assert.equal(r.request_source, 1);
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

check("同一层多档命中时先取第一档，后面的档不再参与", () => {
  // 当前实现只在每层取第一个命中的档位，后一档完全不生效（包括它填了的维度）。
  // 这里把现状钉住：UI 提示、被覆盖档位的标红判定都必须按这个口径写，否则会骗人。
  const first = { days: [5], start: "00:00", end: "12:00", token_multiplier: 0.4, request_multiplier: 2 };
  const second = { days: [5], start: "00:00", end: "12:00", token_multiplier: null, request_multiplier: 7 };
  const r = resolveLayeredMultiplier(1, 1, [[first, second]], friday10);
  assert.equal(r.token_multiplier, 0.4);
  assert.equal(r.request_multiplier, 2);
  assert.equal(r.token_schedule_index, 0);
  assert.equal(r.request_schedule_index, 0);
});

check("重复档位命中时按下标而不是按内容定位", () => {
  // 两档内容完全一致时，按对象反查会永远拿到第 0 档，展示侧就会标错「命中第几档」
  const dup = { days: [5], start: "00:00", end: "12:00", token_multiplier: 0.4, request_multiplier: null };
  const r = resolveLayeredMultiplier(1, 1, [[dup, { ...dup }]], friday10);
  assert.equal(r.token_schedule_index, 0);
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

check("来源文案按维度说，不留「命中」和「来源」混用的语病", () => {
  const bothModel = describeScheduleSource({
    tokenFromModelSchedule: true,
    requestFromModelSchedule: true,
    tokenScheduled: true,
    requestScheduled: true,
  });
  assert.equal(bothModel, "两个维度都来自模型级分时档");
  const tokenModelOnly = describeScheduleSource({
    tokenFromModelSchedule: true,
    requestFromModelSchedule: false,
    tokenScheduled: true,
    requestScheduled: true,
  });
  assert.equal(tokenModelOnly, "Token 倍率来自模型级分时档，请求倍率来自渠道级分时档");
  // 渠道档在该维度也留空时，值就是基础倍率，不能说成「渠道级分时档」
  const noScheduleOnRequest = describeScheduleSource({
    tokenFromModelSchedule: false,
    requestFromModelSchedule: false,
    tokenScheduled: true,
    requestScheduled: false,
  });
  assert.equal(noScheduleOnRequest, "Token 倍率来自渠道级分时档，请求倍率来自基础倍率");
});

check("聚合来源文案带「有渠道」限定，不说成整体命中", () => {
  const partial = describeAggregatedScheduleSource({
    tokenFromModelSchedule: true,
    requestFromModelSchedule: false,
    tokenScheduled: true,
    requestScheduled: true,
  });
  assert.equal(partial, "Token 倍率有渠道由模型级分时档覆盖，请求倍率没有渠道由模型级分时档覆盖");
  const none = describeAggregatedScheduleSource({
    tokenFromModelSchedule: false,
    requestFromModelSchedule: false,
    tokenScheduled: true,
    requestScheduled: true,
  });
  assert.equal(none, "没有渠道由模型级分时档覆盖，倍率来自渠道级分时档或基础倍率");
});

check("渠道档只命中一个维度时，另一个维度不该被标成分时来源", () => {
  // 明细行的「渠道分时」标记依赖维度级判断：用渠道整体的 schedule_applied 会把没被覆盖的维度也标上
  const r = resolveLayeredMultiplier(2, 4, [[], [channelWeekday]], friday10);
  assert.equal(r.schedule_applied, true);
  assert.equal(r.token_source !== null, true);
  assert.equal(r.request_source !== null, false);
});

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);

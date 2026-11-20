// 运行时验证分时倍率的逐层覆盖口径：模型档优先、渠道档只补模型留空的维度。
// 直接驱动 lib/gateway/multiplier-schedule.ts，不依赖数据库与 Next 运行时。
//
// 运行：
//   node --loader ./scripts/verify-channel-quota-mode-loader.mjs scripts/verify-multiplier-layering.mjs
import assert from "node:assert/strict";
import {
  findEffectiveScheduleIndex,
  parseMultiplierSchedules,
  resolveLayeredMultiplier,
  validateMultiplierSchedules,
} from "@/lib/gateway/multiplier-schedule";
import { findShadowedDraftIndexes } from "@/lib/shared/multiplier-shadow";
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

check("聚合来源文案带「至少一条渠道」限定，不说成整体命中", () => {
  const both = describeAggregatedScheduleSource({
    tokenFromModelSchedule: true,
    requestFromModelSchedule: true,
  });
  assert.equal(both, "两个维度都至少有一条渠道由模型级分时档覆盖");
  const partial = describeAggregatedScheduleSource({
    tokenFromModelSchedule: true,
    requestFromModelSchedule: false,
  });
  assert.equal(
    partial,
    "Token 倍率至少有一条渠道由模型级分时档覆盖，请求倍率没有任何渠道命中模型级分时档（来自渠道级分时档或基础倍率）",
  );
  const none = describeAggregatedScheduleSource({
    tokenFromModelSchedule: false,
    requestFromModelSchedule: false,
  });
  assert.equal(none, "没有任何渠道命中模型级分时档，倍率来自渠道级分时档或基础倍率");
});

check("渠道档只命中一个维度时，另一个维度不该被标成分时来源", () => {
  // 明细行的「渠道分时」标记依赖维度级判断：用渠道整体的 schedule_applied 会把没被覆盖的维度也标上
  const r = resolveLayeredMultiplier(2, 4, [[], [channelWeekday]], friday10);
  assert.equal(r.schedule_applied, true);
  assert.equal(r.token_source !== null, true);
  assert.equal(r.request_source !== null, false);
});

// 「永远不会生效」的判定必须和网关的命中顺序逐分钟对齐：某档在 7×1440 分钟里
// 一次都没成为「第一个命中」的档位，才算永远轮不到。这里直接用网关的
// findEffectiveScheduleIndex 穷举，避免两边各写一套口径后漂移。
const MONDAY_UTC = Date.UTC(2026, 10, 16);
function utcWallTimeOf(day, minutes) {
  return new Date(MONDAY_UTC + (day - 1) * 86400000 + minutes * 60000);
}

function shadowedByGateway(windows) {
  const layer = windows.map((w) => ({ ...w, token_multiplier: 1, request_multiplier: null }));
  const shadowed = new Set();
  for (let i = 0; i < layer.length; i += 1) {
    let wins = false;
    for (let day = 1; day <= 7 && !wins; day += 1) {
      for (let minute = 0; minute < 1440; minute += 1) {
        if (findEffectiveScheduleIndex(layer, utcWallTimeOf(day, minute)) === i) {
          wins = true;
          break;
        }
      }
    }
    if (!wins) shadowed.add(i);
  }
  return shadowed;
}

// 这里的档位都填了 Token 倍率，等价于「真的会落库」，草稿过滤不会把它们剔掉。
const asDraft = (window) => ({ ...window, token_multiplier: "1", request_multiplier: "" });

function shadowedIndexes(windows) {
  return [...findShadowedDraftIndexes(windows.map(asDraft))].sort((a, b) => a - b);
}

function assertShadowed(windows) {
  assert.deepEqual(shadowedIndexes(windows), [...shadowedByGateway(windows)].sort((a, b) => a - b));
}

check("被覆盖档位：单档整段覆盖，后面的档标红", () => {
  assertShadowed([
    { days: [1], start: "00:00", end: "12:00" },
    { days: [1], start: "08:00", end: "10:00" },
  ]);
});

check("被覆盖档位：两档拼接盖住第三档", () => {
  const windows = [
    { days: [1], start: "00:00", end: "06:00" },
    { days: [1], start: "06:00", end: "12:00" },
    { days: [1], start: "00:00", end: "12:00" },
  ];
  assert.deepEqual(shadowedIndexes(windows), [2]);
  assertShadowed(windows);
});

check("被覆盖档位：端点差一分钟也算拼上（闭区间里没有空档）", () => {
  // 06:00 属于前一段的最后一分钟，06:01 是后一段的第一分钟，两条档位合起来盖满目标
  const windows = [
    { days: [1], start: "00:00", end: "06:00" },
    { days: [1], start: "06:01", end: "12:00" },
    { days: [1], start: "00:00", end: "12:00" },
  ];
  assert.deepEqual(shadowedIndexes(windows), [2]);
  assertShadowed(windows);
});

check("被覆盖档位：跨零点档位与次日档位拼起来", () => {
  const windows = [
    { days: [1], start: "22:00", end: "02:00" },
    { days: [2], start: "02:00", end: "06:00" },
    { days: [1], start: "23:00", end: "05:00" },
  ];
  assert.deepEqual(shadowedIndexes(windows), [2]);
  assertShadowed(windows);
});

check("被覆盖档位：到 23:59 的档位盖住跨零点目标的当天段", () => {
  const windows = [
    { days: [1], start: "20:00", end: "23:59" },
    { days: [2], start: "00:00", end: "06:00" },
    { days: [1], start: "23:00", end: "00:00" },
  ];
  assert.deepEqual(shadowedIndexes(windows), [2]);
  assertShadowed(windows);
});

check("被覆盖档位：部分覆盖与自引用不标红", () => {
  assert.deepEqual(shadowedIndexes([{ days: [1], start: "00:00", end: "12:00" }]), []);
  assert.deepEqual(
    shadowedIndexes([
      { days: [1], start: "00:00", end: "06:00" },
      { days: [1], start: "00:00", end: "12:00" },
    ]),
    [],
  );
  assert.deepEqual(
    shadowedIndexes([
      { days: [5], start: "08:00", end: "10:00" },
      { days: [1, 2, 3, 4, 5, 6, 7], start: "10:01", end: "11:00" },
    ]),
    [],
  );
});

check("被覆盖档位：还没填完的草稿不参与覆盖也不标红", () => {
  // 编辑器把未选星期、两个维度都留空的草稿按空时段跳过：它们落库时会被丢弃，
  // 既不该被标红，也不该把后面真正生效的档位盖掉，且下标要保持在原来那一行。
  const draft = (days, start, end, token, request) => ({
    days,
    start,
    end,
    token_multiplier: token,
    request_multiplier: request,
  });
  assert.deepEqual(
    [...findShadowedDraftIndexes([
      draft([], "00:00", "12:00", "", ""),
      draft([1], "00:00", "12:00", "0.5", ""),
    ])],
    [],
  );
  assert.deepEqual(
    [...findShadowedDraftIndexes([
      draft([], "00:00", "12:00", "", ""),
      draft([1], "00:00", "12:00", "0.5", ""),
      draft([1], "00:00", "12:00", "0.7", "2"),
    ])],
    [2],
  );
  // 只填了星期/时间但没填倍率的草稿同样会被丢弃，不能盖住后面的档位
  assert.deepEqual(
    [...findShadowedDraftIndexes([
      draft([1], "00:00", "12:00", "  ", "  "),
      draft([1], "00:00", "12:00", "", "3"),
    ])],
    [],
  );
});

check("被覆盖档位与网关命中顺序逐分钟一致（随机组合）", () => {
  let seed = 20261120;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const timePoints = ["00:00", "01:00", "02:00", "06:00", "08:00", "12:00", "18:00", "22:00", "23:00", "23:59"];
  for (let round = 0; round < 60; round += 1) {
    const count = 2 + Math.floor(rand() * 3);
    const windows = [];
    for (let i = 0; i < count; i += 1) {
      const dayCount = 1 + Math.floor(rand() * 2);
      const days = [...new Set(Array.from({ length: dayCount }, () => 1 + Math.floor(rand() * 7)))].sort((a, b) => a - b);
      const start = timePoints[Math.floor(rand() * timePoints.length)];
      let end = timePoints[Math.floor(rand() * timePoints.length)];
      while (end === start) end = timePoints[Math.floor(rand() * timePoints.length)];
      windows.push({ days, start, end });
    }
    assertShadowed(windows);
  }
});

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);

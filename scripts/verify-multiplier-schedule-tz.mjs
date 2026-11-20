// 运行时验证分时档「浏览器墙上时间 <=> UTC」换算：
// 1. 正反向互逆；
// 2. 逐分钟语义等价（墙上时间窗口的命中集合与 UTC 窗口完全一致）；
// 3. 编辑器「被覆盖档位」标红在墙上时间下与 UTC 下结果相同（平移是双射，覆盖关系不变）；
// 4. 草稿与落库载荷的映射往返不丢字段；
// 5. 换算不可行（夏令时跳表空档、非法时区）与非法倍率必须报错，不能静默落库。
//
// 所有用例显式传参考日：默认值是「今天」，对比基准却是固定日期，会让用例随运行季节在
// 夏令时时区上翻车；主用例再各跑一遍冬季与夏季参考日，避免某个实现分支忽略 base 时漏测。
//
// 运行：
//   node --loader ./scripts/verify-channel-quota-mode-loader.mjs scripts/verify-multiplier-schedule-tz.mjs
import assert from "node:assert/strict";
import { findEffectiveScheduleIndex } from "@/lib/gateway/multiplier-schedule";
import { findShadowedDraftIndexes } from "@/lib/shared/multiplier-shadow";
import {
  scheduleDraftsToPayload,
  scheduleToLocal,
  schedulesToDrafts,
  scheduleToUtc,
  tryScheduleToUtc,
} from "@/lib/shared/multiplier-schedule-tz";

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

// 覆盖东八区（无夏令时）、半小时时区、北美与南半球夏令时时区
const TIME_ZONES = ["UTC", "Asia/Shanghai", "Asia/Kolkata", "America/New_York", "Australia/Sydney"];

const WINDOWS = [
  { name: "普通白天档", window: { days: [5], start: "08:00", end: "14:00" } },
  { name: "跨零点档", window: { days: [5], start: "22:00", end: "06:00" } },
  { name: "凌晨档（换算后落到前一天）", window: { days: [5], start: "00:00", end: "08:00" } },
  { name: "多天且接近全天", window: { days: [1, 3, 5, 7], start: "05:30", end: "23:59" } },
  { name: "周界档（周日跨到周一）", window: { days: [7], start: "23:00", end: "01:00" } },
];

// 两个参考日都是周一，且各自那一周内上述时区都没有夏令时切换，
// 逐分钟比对不受切换点干扰；冬夏各跑一遍可发现忽略参考日的实现分支
const BASE_MS_LIST = [Date.UTC(2024, 0, 1), Date.UTC(2024, 6, 1)];
const MINUTES_PER_WEEK = 7 * 24 * 60;

function normalize(window) {
  return {
    days: [...new Set(window.days)].sort((a, b) => a - b),
    start: window.start,
    end: window.end,
  };
}

// 指定时区在某时刻的墙上偏移（分钟）：本地 = UTC + offset
function zoneOffsetMinutes(timeZone, date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const asUtc = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(hour),
    Number(get("minute")),
    Number(get("second")),
  );
  return (asUtc - date.getTime()) / 60_000;
}

check("正反向换算互逆", () => {
  for (const baseMs of BASE_MS_LIST) {
    const base = new Date(baseMs);
    for (const { window } of WINDOWS) {
      for (const timeZone of TIME_ZONES) {
        const utc = normalize(window);
        const local = scheduleToLocal(utc, timeZone, base);
        assert.deepEqual(scheduleToUtc(local, timeZone, base), utc, `${timeZone} 窗口=${JSON.stringify(utc)}`);
        assert.deepEqual(scheduleToLocal(scheduleToUtc(local, timeZone, base), timeZone, base), local);
      }
    }
  }
});

check("东八区凌晨档落到前一天的 UTC 时段", () => {
  const local = { days: [5], start: "00:00", end: "08:00" };
  for (const baseMs of BASE_MS_LIST) {
    const base = new Date(baseMs);
    assert.deepEqual(scheduleToUtc(local, "Asia/Shanghai", base), { days: [4], start: "16:00", end: "00:00" });
    assert.deepEqual(scheduleToLocal({ days: [4], start: "16:00", end: "00:00" }, "Asia/Shanghai", base), local);
  }
});

check("逐分钟语义等价：墙上时间窗口与 UTC 窗口命中完全一致", () => {
  for (const baseMs of BASE_MS_LIST) {
    const base = new Date(baseMs);
    // 用例前提：参考日是周一、且参考周内没有夏令时切换，否则单偏移假设不成立
    assert.equal(base.getUTCDay(), 1, `参考日必须是周一：${base.toISOString()}`);
    for (const timeZone of TIME_ZONES) {
      assert.equal(
        zoneOffsetMinutes(timeZone, base),
        zoneOffsetMinutes(timeZone, new Date(baseMs + (MINUTES_PER_WEEK - 1) * 60_000)),
        `${timeZone} 的参考周含夏令时切换，逐分钟等价用例不适用`,
      );
    }
    for (const { name, window } of WINDOWS) {
      for (const timeZone of TIME_ZONES) {
        const utcWindow = scheduleToUtc(normalize(window), timeZone, base);
        const localWindow = scheduleToLocal(utcWindow, timeZone, base);
        const offset = zoneOffsetMinutes(timeZone, base);
        for (let minute = 0; minute < MINUTES_PER_WEEK; minute += 1) {
          const utcDate = new Date(baseMs + minute * 60_000);
          // 把该时刻的墙上时间当作「UTC 字段」喂给同一个判定函数，比较两者的命中集合
          const wallDate = new Date(utcDate.getTime() + offset * 60_000);
          const hitUtc = findEffectiveScheduleIndex([utcWindow], utcDate) !== null;
          const hitLocal = findEffectiveScheduleIndex([localWindow], wallDate) !== null;
          if (hitLocal !== hitUtc) {
            assert.fail(
              `${name} ${timeZone} base=${base.toISOString()} minute=${minute}`
              + `（UTC ${JSON.stringify(utcWindow)} / 本地 ${JSON.stringify(localWindow)}）`,
            );
          }
        }
      }
    }
  }
});

check("被覆盖档位标红在墙上时间下不变", () => {
  const utcDrafts = [
    { days: [5], start: "00:00", end: "12:00", token_multiplier: "0.5", request_multiplier: "" },
    { days: [5], start: "00:00", end: "12:00", token_multiplier: "0.2", request_multiplier: "" },
    { days: [5], start: "12:01", end: "20:00", token_multiplier: "0.3", request_multiplier: "" },
    { days: [5], start: "00:00", end: "23:59", token_multiplier: "0.4", request_multiplier: "" },
  ];
  const expected = [...findShadowedDraftIndexes(utcDrafts)].sort((a, b) => a - b);
  for (const baseMs of BASE_MS_LIST) {
    const base = new Date(baseMs);
    for (const timeZone of TIME_ZONES) {
      const localDrafts = utcDrafts.map((draft) => ({
        ...scheduleToLocal(draft, timeZone, base),
        token_multiplier: draft.token_multiplier,
        request_multiplier: draft.request_multiplier,
      }));
      assert.deepEqual(
        [...findShadowedDraftIndexes(localDrafts)].sort((a, b) => a - b),
        expected,
        timeZone,
      );
    }
  }
});

check("草稿与载荷往返不丢字段", () => {
  for (const baseMs of BASE_MS_LIST) {
    const base = new Date(baseMs);
    for (const { window } of WINDOWS) {
      for (const timeZone of TIME_ZONES) {
        const payload = [
          { ...normalize(window), token_multiplier: 0.5, request_multiplier: null },
          { ...normalize(window), token_multiplier: null, request_multiplier: 2 },
        ];
        assert.deepEqual(
          scheduleDraftsToPayload(schedulesToDrafts(payload, timeZone, base), timeZone, base),
          payload,
        );
      }
    }
  }
});

check("留空与填 0 的语义不被映射改写", () => {
  const drafts = [
    { key: "a", days: [1], start: "09:00", end: "10:00", token_multiplier: "0", request_multiplier: "" },
    { key: "b", days: [1], start: "11:00", end: "12:00", token_multiplier: "", request_multiplier: "" },
    { key: "c", days: [], start: "13:00", end: "14:00", token_multiplier: "1", request_multiplier: "" },
  ];
  const payload = scheduleDraftsToPayload(drafts, "Asia/Shanghai", new Date(BASE_MS_LIST[0]));
  assert.equal(payload.length, 1);
  assert.deepEqual(payload[0], { days: [1], start: "01:00", end: "02:00", token_multiplier: 0, request_multiplier: null });
});

check("时间非法或首尾相同时原样保留，交给服务端拒绝", () => {
  const base = new Date(BASE_MS_LIST[0]);
  const draft = { days: [3], start: "10:00", end: "10:00" };
  assert.deepEqual(scheduleToLocal(draft, "Asia/Shanghai", base), draft);
  assert.deepEqual(scheduleToUtc(draft, "Asia/Shanghai", base), draft);
  const noDays = { days: [], start: "10:00", end: "12:00" };
  assert.deepEqual(scheduleToUtc(noDays, "Asia/Shanghai", base), noDays);
});

check("夏令时跳表空档里的时段拒绝换算，而不是把墙上时间当 UTC 落库", () => {
  const window = { days: [7], start: "02:30", end: "03:30" };
  // 2024-03-10 是美东夏令时切换日，当地 02:00-03:00 这一小时不存在
  const dstDay = new Date(Date.UTC(2024, 2, 10, 12, 0, 0));
  assert.equal(tryScheduleToUtc(window, "America/New_York", dstDay), null);
  const drafts = [{ key: "a", days: [7], start: "02:30", end: "03:30", token_multiplier: "0.5", request_multiplier: "" }];
  assert.throws(() => scheduleDraftsToPayload(drafts, "America/New_York", dstDay), /第 1 档/);
  // 非切换日同一档正常换算：美东冬令时 02:30 = UTC 07:30
  const winterDay = new Date(Date.UTC(2024, 1, 18, 12, 0, 0));
  assert.deepEqual(scheduleToUtc(window, "America/New_York", winterDay), { days: [7], start: "07:30", end: "08:30" });
});

check("倍率不是有效数字时直接报错，不静默降级", () => {
  const drafts = [{ key: "a", days: [1], start: "09:00", end: "10:00", token_multiplier: "abc", request_multiplier: "" }];
  assert.throws(() => scheduleDraftsToPayload(drafts, "UTC", new Date(BASE_MS_LIST[0])), /不是有效数字/);
});

check("非法时区返回 null 而不是伪造 00:00", () => {
  const base = new Date(BASE_MS_LIST[0]);
  assert.equal(tryScheduleToUtc({ days: [1], start: "09:00", end: "10:00" }, "Not/AZone", base), null);
  const drafts = [{ key: "a", days: [1], start: "09:00", end: "10:00", token_multiplier: "0.5", request_multiplier: "" }];
  assert.throws(() => scheduleDraftsToPayload(drafts, "Not/AZone", base), /第 1 档/);
});

console.log("");
if (failed > 0) {
  console.error(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(1);
}
console.log(`通过 ${passed} 项，失败 0 项`);

// 运行时验证「时段窗口 ⇄ UTC」换算（渠道限制时段与分时倍率共用 lib/shared/time-window.ts）：
// 1. 正反向互逆；
// 2. 逐分钟语义等价（墙上时间窗口的命中集合与 UTC 窗口完全一致）；
// 3. 编辑器「被覆盖档位」标红在墙上时间下与 UTC 下结果相同（平移是双射，覆盖关系不变）；
// 4. 编辑器行与落库 JSON 往返不丢字段，未填完的行不落库，首尾相同的行被标记为不可换算；
// 5. 换算不可行（夏令时跳表空档、非法时区）与非法倍率必须报错，不能静默落库。
//
// 所有用例显式传参考日：默认值是「今天」，对比基准却是固定日期，会让用例随运行季节在
// 夏令时时区上翻车；主用例再各跑一遍冬季与夏季参考日，避免某个实现分支忽略 base 时漏测。
//
// 运行：
//   node --loader ./scripts/verify-channel-quota-mode-loader.mjs scripts/verify-time-window-tz.mjs
import assert from "node:assert/strict";
import { findEffectiveScheduleIndex } from "@/lib/gateway/multiplier-schedule";
import { findShadowedDraftIndexes } from "@/lib/shared/multiplier-shadow";
import {
  describeTimeRestrictions,
  isChannelTimeAllowed,
  parseTimeRestrictions,
  validateTimeRestrictions,
} from "@/lib/gateway/channel-time";
import {
  matchesWindow,
  parseTimeWindows,
  serializeTimeWindows,
  windowToWall,
  windowToUtc,
} from "@/lib/shared/time-window";
import { scheduleDraftsToPayload, schedulesToDrafts } from "@/lib/shared/multiplier-schedule-tz";
import {
  describeChannelSchedules,
  describeScheduleTooltip,
  describeScheduleWindows,
  formatScheduleDays,
  formatScheduleMultipliers,
  formatScheduleTime,
} from "@/lib/shared/multiplier-schedule-text";

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
// 含两个极端偏移（+14 / -11）、45 分钟时区、半小时夏令时（Lord Howe）：
// 墙上时间与 UTC 的换算在「跨日」「半小时偏移」「夏令时切换」上最容易出错
const TIME_ZONES = [
  "UTC",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "America/New_York",
  "Australia/Sydney",
  "Pacific/Kiritimati",
  "Pacific/Midway",
  "Asia/Kathmandu",
  "Australia/Lord_Howe",
];

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

function converted(fn, window, timeZone, base) {
  const result = fn(window, timeZone, base);
  assert.ok(result, `${timeZone} 窗口=${JSON.stringify(window)} 换算失败`);
  return result;
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
        const wall = converted(windowToWall, utc, timeZone, base);
        assert.deepEqual(windowToUtc(wall, timeZone, base), utc, `${timeZone} 窗口=${JSON.stringify(utc)}`);
        assert.deepEqual(windowToWall(converted(windowToUtc, wall, timeZone, base), timeZone, base), wall);
      }
    }
  }
});

check("东八区凌晨档落到前一天的 UTC 时段", () => {
  const wall = { days: [5], start: "00:00", end: "08:00" };
  for (const baseMs of BASE_MS_LIST) {
    const base = new Date(baseMs);
    assert.deepEqual(windowToUtc(wall, "Asia/Shanghai", base), { days: [4], start: "16:00", end: "00:00" });
    assert.deepEqual(windowToWall({ days: [4], start: "16:00", end: "00:00" }, "Asia/Shanghai", base), wall);
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
        const utcWindow = converted(windowToUtc, normalize(window), timeZone, base);
        const wallWindow = converted(windowToWall, utcWindow, timeZone, base);
        const offset = zoneOffsetMinutes(timeZone, base);
        for (let minute = 0; minute < MINUTES_PER_WEEK; minute += 1) {
          const utcDate = new Date(baseMs + minute * 60_000);
          // 把该时刻的墙上时间当作「UTC 字段」喂给同一个判定函数，比较两者的命中集合
          const wallDate = new Date(utcDate.getTime() + offset * 60_000);
          const hitUtc = findEffectiveScheduleIndex([utcWindow], utcDate) !== null;
          const hitWall = findEffectiveScheduleIndex([wallWindow], wallDate) !== null;
          if (hitWall !== hitUtc) {
            assert.fail(
              `${name} ${timeZone} base=${base.toISOString()} minute=${minute}`
              + `（UTC ${JSON.stringify(utcWindow)} / 墙上 ${JSON.stringify(wallWindow)}）`,
            );
          }
        }
      }
    }
  }
});

check("跨零点窗口的凌晨段归属前一日", () => {
  const window = { days: [1], start: "22:00", end: "06:00" };
  assert.equal(matchesWindow(window, 1, 23 * 60), true, "周一 23:00");
  assert.equal(matchesWindow(window, 2, 5 * 60), true, "周二 05:00");
  assert.equal(matchesWindow(window, 1, 5 * 60), false, "周一 05:00 不在窗口内");
  assert.equal(matchesWindow(window, 2, 23 * 60), false, "周二 23:00 不在窗口内");
});

check("首尾相同的时段整天都不放行", () => {
  const window = { days: [1], start: "10:00", end: "10:00" };
  for (let minute = 0; minute < 1440; minute += 1) {
    if (matchesWindow(window, 1, minute)) assert.fail(`minute=${minute} 不该命中`);
  }
  assert.equal(isChannelTimeAllowed(JSON.stringify([window]), new Date(Date.UTC(2024, 0, 1, 10, 0, 0))), false);
});

check("限制时段解析补零：9:30 归一化为 09:30", () => {
  const json = JSON.stringify([{ days: [1], start: "9:30", end: "18:00" }]);
  assert.deepEqual(parseTimeRestrictions(json), [{ days: [1], start: "09:30", end: "18:00" }]);
});

check("写侧先归一化再校验：9:30 与 09:30 视为同一时刻", () => {
  assert.equal(validateTimeRestrictions([{ days: [1], start: "9:30", end: "09:30" }]).valid, false);
  assert.deepEqual(
    validateTimeRestrictions([{ days: [1], start: "9:30", end: "18:00" }]),
    { valid: true, windows: [{ days: [1], start: "09:30", end: "18:00" }] },
  );
});

check("历史单小时位数据在编辑器里补零而不是变成空框", () => {
  const parsed = parseTimeWindows(
    JSON.stringify([{ days: [1], start: "9:30", end: "18:00" }]),
    "UTC",
    new Date(BASE_MS_LIST[0]),
  );
  assert.deepEqual(parsed.failed, []);
  assert.deepEqual(parsed.windows, [{ days: [1], start: "09:30", end: "18:00" }]);
});

check("限制时段配置损坏时按拒绝处理，而不是悄悄放开", () => {
  const now = new Date(Date.UTC(2024, 0, 1, 5, 0, 0));
  assert.equal(isChannelTimeAllowed("", now), true, "未配置 = 不限制");
  assert.equal(isChannelTimeAllowed(null, now), true, "未配置 = 不限制");
  assert.equal(isChannelTimeAllowed("[]", now), true, "空数组 = 未配置");
  assert.equal(isChannelTimeAllowed("not-json", now), false, "解析失败 = 拒绝");
  assert.equal(isChannelTimeAllowed("{}", now), false, "非数组 = 拒绝");
  assert.equal(isChannelTimeAllowed("null", now), false, "null 文本 = 拒绝");
  assert.equal(
    isChannelTimeAllowed(JSON.stringify([{ days: [1], start: "10:00", end: "10:00" }]), now),
    false,
    "整份配置都是无效行 = 拒绝",
  );
});

check("回填时格式异常的时段报 failed，不会被当成未填完静默丢弃", () => {
  const base = new Date(BASE_MS_LIST[0]);
  const parsed = parseTimeWindows(
    JSON.stringify([{ days: [1], start: "24:00", end: "18:00" }]),
    "UTC",
    base,
  );
  assert.deepEqual(parsed.failed, [0]);
  assert.deepEqual(parsed.windows, [{ days: [1], start: "24:00", end: "18:00" }]);
  // 星期写了但一个都认不出：同样算填写有误，不能伪装成「未选星期」
  const badDays = parseTimeWindows(
    JSON.stringify([{ days: [0, 8], start: "09:00", end: "18:00" }]),
    "UTC",
    base,
  );
  assert.deepEqual(badDays.failed, [0]);
});

check("三态判断与运行时、管理端同源", () => {
  assert.equal(describeTimeRestrictions(""), "none");
  assert.equal(describeTimeRestrictions("[]"), "none");
  assert.equal(describeTimeRestrictions(JSON.stringify([{ days: [1], start: "09:00", end: "18:00" }])), "ok");
  assert.equal(describeTimeRestrictions("not-json"), "broken");
  assert.equal(describeTimeRestrictions("{}"), "broken");
  assert.equal(describeTimeRestrictions(JSON.stringify([{ days: [1], start: "10:00", end: "10:00" }])), "broken");
});

check("选了星期但时分非法时阻断保存，未选星期的空行才允许忽略", () => {
  const base = new Date(BASE_MS_LIST[0]);
  const withDays = serializeTimeWindows([{ days: [1], start: "24:00", end: "" }], "UTC", base);
  assert.deepEqual(withDays.failed, [0]);
  const withoutDays = serializeTimeWindows([{ days: [], start: "24:00", end: "18:00" }], "UTC", base);
  assert.deepEqual(withoutDays.failed, []);
  assert.equal(withoutDays.json, "[]");
});

check("渠道可用时段：墙上时间窗口与换算后的 UTC 窗口逐分钟一致", () => {
  for (const baseMs of BASE_MS_LIST) {
    const base = new Date(baseMs);
    for (const { name, window } of WINDOWS) {
      for (const timeZone of TIME_ZONES) {
        const wallWindow = normalize(window);
        const utcWindow = converted(windowToUtc, wallWindow, timeZone, base);
        const offset = zoneOffsetMinutes(timeZone, base);
        const json = JSON.stringify([utcWindow]);
        for (let minute = 0; minute < MINUTES_PER_WEEK; minute += 1) {
          const utcDate = new Date(baseMs + minute * 60_000);
          const wallDate = new Date(utcDate.getTime() + offset * 60_000);
          const wallDay = wallDate.getUTCDay() === 0 ? 7 : wallDate.getUTCDay();
          const wallMinutes = wallDate.getUTCHours() * 60 + wallDate.getUTCMinutes();
          const expected = matchesWindow(wallWindow, wallDay, wallMinutes);
          const actual = isChannelTimeAllowed(json, utcDate);
          if (actual !== expected) {
            assert.fail(
              `${name} ${timeZone} base=${base.toISOString()} minute=${minute}`
              + `（UTC ${JSON.stringify(utcWindow)} / 墙上 ${JSON.stringify(wallWindow)}）`,
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
      const wallDrafts = utcDrafts.map((draft) => ({
        ...converted(windowToWall, draft, timeZone, base),
        token_multiplier: draft.token_multiplier,
        request_multiplier: draft.request_multiplier,
      }));
      assert.deepEqual(
        [...findShadowedDraftIndexes(wallDrafts)].sort((a, b) => a - b),
        expected,
        timeZone,
      );
    }
  }
});

check("分时档草稿与载荷往返不丢字段", () => {
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

check("限制时段：编辑行与落库 JSON 往返一致", () => {
  for (const baseMs of BASE_MS_LIST) {
    const base = new Date(baseMs);
    for (const { window } of WINDOWS) {
      for (const timeZone of TIME_ZONES) {
        const windows = [normalize(window)];
        const { json, failed: failedRows } = serializeTimeWindows(windows, timeZone, base);
        assert.deepEqual(failedRows, [], timeZone);
        const parsed = parseTimeWindows(json, timeZone, base);
        assert.deepEqual(parsed.failed, [], timeZone);
        assert.deepEqual(parsed.windows, windows, `${timeZone} 窗口=${JSON.stringify(windows)}`);
      }
    }
  }
});

check("限制时段：未选星期的行不落库，选了星期但填写有误的行阻断保存", () => {
  const base = new Date(BASE_MS_LIST[0]);
  const windows = [
    { days: [], start: "09:00", end: "18:00" },
    { days: [1], start: "", end: "" },
    { days: [2], start: "10:00", end: "10:00" },
    { days: [3], start: "08:00", end: "09:00" },
  ];
  const { json, failed: failedRows } = serializeTimeWindows(windows, "Asia/Shanghai", base);
  // 第 1 行未选星期：跳过；第 2、3 行选了星期却填错：保留原值并报错阻断保存
  assert.deepEqual(failedRows, [1, 2]);
  assert.deepEqual(JSON.parse(json), [
    { days: [1], start: "", end: "" },
    { days: [2], start: "10:00", end: "10:00" },
    { days: [3], start: "00:00", end: "01:00" },
  ]);
});

check("分时档留空与填 0 的语义不被映射改写", () => {
  const drafts = [
    { key: "a", days: [1], start: "09:00", end: "10:00", token_multiplier: "0", request_multiplier: "" },
    { key: "b", days: [1], start: "11:00", end: "12:00", token_multiplier: "", request_multiplier: "" },
    { key: "c", days: [], start: "13:00", end: "14:00", token_multiplier: "1", request_multiplier: "" },
  ];
  const payload = scheduleDraftsToPayload(drafts, "Asia/Shanghai", new Date(BASE_MS_LIST[0]));
  assert.equal(payload.length, 1);
  assert.deepEqual(payload[0], { days: [1], start: "01:00", end: "02:00", token_multiplier: 0, request_multiplier: null });
});

check("夏令时跳表空档里的时段拒绝换算，而不是把墙上时间当 UTC 落库", () => {
  const window = { days: [7], start: "02:30", end: "03:30" };
  // 2024-03-10 是美东夏令时切换日，当地 02:00-03:00 这一小时不存在
  const dstDay = new Date(Date.UTC(2024, 2, 10, 12, 0, 0));
  assert.equal(windowToUtc(window, "America/New_York", dstDay), null);
  const serialized = serializeTimeWindows([window], "America/New_York", dstDay);
  assert.deepEqual(serialized.failed, [0]);
  const drafts = [{ key: "a", days: [7], start: "02:30", end: "03:30", token_multiplier: "0.5", request_multiplier: "" }];
  assert.throws(() => scheduleDraftsToPayload(drafts, "America/New_York", dstDay), /第 1 档/);
  // 非切换日同一档正常换算：美东冬令时 02:30 = UTC 07:30
  const winterDay = new Date(Date.UTC(2024, 1, 18, 12, 0, 0));
  assert.deepEqual(windowToUtc(window, "America/New_York", winterDay), { days: [7], start: "07:30", end: "08:30" });
});

check("非法时区返回 null 而不是伪造 00:00", () => {
  const base = new Date(BASE_MS_LIST[0]);
  const window = { days: [1], start: "09:00", end: "10:00" };
  assert.equal(windowToUtc(window, "Not/AZone", base), null);
  assert.equal(windowToWall(window, "Not/AZone", base), null);
  assert.deepEqual(serializeTimeWindows([window], "Not/AZone", base).failed, [0]);
  assert.deepEqual(parseTimeWindows(JSON.stringify([window]), "Not/AZone", base).failed, [0]);
  const drafts = [{ key: "a", days: [1], start: "09:00", end: "10:00", token_multiplier: "0.5", request_multiplier: "" }];
  assert.throws(() => scheduleDraftsToPayload(drafts, "Not/AZone", base), /第 1 档/);
});

check("倍率不是有效数字时直接报错，不静默降级", () => {
  const drafts = [{ key: "a", days: [1], start: "09:00", end: "10:00", token_multiplier: "abc", request_multiplier: "" }];
  assert.throws(() => scheduleDraftsToPayload(drafts, "UTC", new Date(BASE_MS_LIST[0])), /不是有效数字/);
});

check("分时档文案：星期、跨零点与倍率", () => {
  assert.equal(formatScheduleDays([1, 2, 3, 4, 5]), "周一至周五");
  assert.equal(formatScheduleDays([1, 2, 3, 4, 5, 6, 7]), "每天");
  assert.equal(formatScheduleDays([1, 3, 5]), "周一、周三、周五");
  assert.equal(formatScheduleDays([7, 1, 2]), "周日至周二");
  assert.equal(formatScheduleDays([6]), "周六");
  assert.equal(formatScheduleTime("22:00", "06:00"), "22:00–次日 06:00");
  assert.equal(formatScheduleTime("08:00", "14:00"), "08:00–14:00");
  assert.equal(
    formatScheduleMultipliers({ days: [1], start: "08:00", end: "14:00", token_multiplier: 1.5, request_multiplier: null }),
    "Token 1.5x",
  );
});

check("分时档文案：按浏览者时区展示，并标出当前命中的档", () => {
  // 库里存的是 UTC：周四 16:00-00:00 = 东八区周五 00:00-08:00；周五 00:00-08:00（UTC）= 周五 08:00-16:00
  const schedules = [
    { days: [4], start: "16:00", end: "00:00", token_multiplier: 0.5, request_multiplier: null },
    { days: [5], start: "00:00", end: "08:00", token_multiplier: 1.5, request_multiplier: 2 },
  ];
  const lines = describeScheduleWindows(schedules, "Asia/Shanghai");
  assert.deepEqual(lines, [
    "周五 00:00–08:00 · Token 0.5x",
    "周五 08:00–16:00 · Token 1.5x / 请求 2x",
  ]);
  // 2024-01-05T00:30Z = 东八区周五 08:30，命中的是第二档
  const now = new Date(Date.UTC(2024, 0, 5, 0, 30));
  const marked = describeScheduleWindows(schedules, "Asia/Shanghai", 1);
  assert.equal(marked[1], "周五 08:00–16:00 · Token 1.5x / 请求 2x（当前生效）");
  const tooltip = describeScheduleTooltip({
    baseToken: 1,
    baseRequest: 1,
    effectiveToken: 1.5,
    effectiveRequest: 2,
    scheduleApplied: true,
    source: "两个维度都来自模型级分时档",
    modelSchedules: schedules,
    now,
    timeZone: "Asia/Shanghai",
  });
  assert.match(tooltip, /当前时段生效 Token 1\.5x \/ 请求 2x/);
  assert.match(tooltip, /模型级：/);
  assert.match(tooltip, /（当前生效）/);
  const grouped = describeChannelSchedules(
    [{ channelName: "渠道 A", modelSchedules: schedules }],
    "Asia/Shanghai",
    now,
  );
  assert.equal(grouped[0], "· 模型档 周五 00:00–08:00 · Token 0.5x");
  assert.match(grouped[grouped.length - 1], /浏览器时区（Asia\/Shanghai）/);
});

console.log("");
if (failed > 0) {
  console.error(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(1);
}
console.log(`通过 ${passed} 项，失败 0 项`);

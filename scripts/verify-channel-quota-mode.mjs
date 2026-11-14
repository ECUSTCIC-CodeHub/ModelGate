// 运行时验证渠道配额模式：驱动真实的 checkChannelQuota 与 quota-mode 判定函数，
// 只把数据库查询 stub 成可控行，避免拉起真实 sqlite/mysql。
//
// 覆盖：
//   1) follow_group / bypass_group 不检查渠道自身配额，也不外露额度
//   2) independent / dual 检查渠道自身配额，并返回剩余额度
//   3) 用户限额放行由模型级与渠道级共同决定（任一级 bypass_group / independent 即放行）
//
// 运行：
//   node --loader ./scripts/verify-channel-quota-mode-loader.mjs scripts/verify-channel-quota-mode.mjs
import assert from "node:assert/strict";
import { checkChannelQuota } from "@/lib/gateway/channel-quota";
import {
  bypassesUserLimits,
  normalizeChannelQuotaMode,
  normalizeModelQuotaMode,
  usesChannelSelfQuota,
  usesModelSelfQuota,
} from "@/lib/gateway/quota-mode";

const stub = globalThis.__channelQuotaStub;
let row = null;

function setChannel(overrides = {}) {
  row = {
    id: 1,
    quota_mode: "dual",
    quota_tokens: null,
    quota_requests: null,
    period_used_tokens: 0,
    period_used_requests: 0,
    period_cycles: null,
    ...overrides,
  };
  stub.queryOne = async () => row;
}

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`场景 ${name}: OK`);
  } catch (error) {
    failed += 1;
    console.error(`场景 ${name}: FAIL`, error.message);
  }
}

async function main() {
  await check("follow_group 不检查渠道配额", async () => {
    setChannel({ quota_mode: "follow_group", quota_requests: 2, period_used_requests: 2, quota_tokens: 1000, period_used_tokens: 1000 });
    const result = await checkChannelQuota(1, 100);
    assert.equal(result.ok, true);
    assert.equal(result.quota.remaining_requests, null);
    assert.equal(result.quota.remaining_tokens, null);
    assert.deepEqual(result.quota.periods, []);
  });

  await check("bypass_group 不检查渠道配额", async () => {
    setChannel({ quota_mode: "bypass_group", quota_requests: 2, period_used_requests: 2 });
    const result = await checkChannelQuota(1, 100);
    assert.equal(result.ok, true);
    assert.equal(result.quota.remaining_requests, null);
  });

  await check("独立配额耗尽请求配额", async () => {
    setChannel({ quota_mode: "independent", quota_requests: 2, period_used_requests: 2 });
    const result = await checkChannelQuota(1, 100);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "渠道请求配额已用尽");
  });

  await check("双重限制耗尽 Token 配额", async () => {
    setChannel({ quota_mode: "dual", quota_tokens: 1000, period_used_tokens: 1000 });
    const result = await checkChannelQuota(1, 100);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "渠道 Token 配额已用尽");
  });

  await check("独立配额返回剩余额度", async () => {
    setChannel({ quota_mode: "independent", quota_requests: 3, period_used_requests: 1 });
    const result = await checkChannelQuota(1, 100);
    assert.equal(result.ok, true);
    assert.equal(result.quota.remaining_requests, 2);
  });

  await check("旧库 NULL 模式按 dual 处理", async () => {
    setChannel({ quota_mode: null, quota_requests: 2, period_used_requests: 2 });
    const result = await checkChannelQuota(1, 100);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "渠道请求配额已用尽");
  });

  await check("渠道不存在", async () => {
    row = null;
    stub.queryOne = async () => row;
    const result = await checkChannelQuota(1, 100);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "渠道不存在");
  });

  await check("配额模式取值判定", () => {
    assert.equal(usesChannelSelfQuota("independent"), true);
    assert.equal(usesChannelSelfQuota("dual"), true);
    assert.equal(usesChannelSelfQuota("follow_group"), false);
    assert.equal(usesChannelSelfQuota("bypass_group"), false);
    // 未知取值按建表默认的 dual 处理，不能让脏值把渠道配额静默关掉
    assert.equal(usesChannelSelfQuota(null), true);
    assert.equal(usesChannelSelfQuota(""), true);
    assert.equal(usesChannelSelfQuota("Dual"), true);
    assert.equal(normalizeChannelQuotaMode("follow_group"), "follow_group");
    assert.equal(normalizeChannelQuotaMode("independent"), "independent");
    assert.equal(normalizeChannelQuotaMode("bypass_group"), "bypass_group");
    assert.equal(normalizeChannelQuotaMode(null), "dual");
    assert.equal(normalizeChannelQuotaMode(undefined), "dual");
    assert.equal(normalizeChannelQuotaMode(""), "dual");
    assert.equal(normalizeChannelQuotaMode(" dual"), "dual");
  });

  await check("模型配额模式归一", () => {
    // 模型级兜底是 follow_group，与渠道级 dual 相反；脏值按兜底不放行模型配额
    assert.equal(normalizeModelQuotaMode(null), "follow_group");
    assert.equal(normalizeModelQuotaMode(undefined), "follow_group");
    assert.equal(normalizeModelQuotaMode(""), "follow_group");
    assert.equal(normalizeModelQuotaMode("dual"), "dual");
    assert.equal(normalizeModelQuotaMode("independent"), "independent");
    assert.equal(usesModelSelfQuota("independent"), true);
    assert.equal(usesModelSelfQuota("dual"), true);
    assert.equal(usesModelSelfQuota("follow_group"), false);
    assert.equal(usesModelSelfQuota("bypass_group"), false);
    assert.equal(usesModelSelfQuota(null), false);
    assert.equal(usesModelSelfQuota(""), false);
  });

  await check("用户限额放行由模型与渠道任一级决定", () => {
    const modes = ["follow_group", "bypass_group", "independent", "dual"];
    for (const modelMode of modes) {
      for (const channelMode of modes) {
        const expected = ["bypass_group", "independent"].includes(modelMode)
          || ["bypass_group", "independent"].includes(channelMode);
        assert.equal(
          bypassesUserLimits({ model: { quota_mode: modelMode }, channel: { quota_mode: channelMode } }),
          expected,
          `model=${modelMode} channel=${channelMode}`,
        );
      }
    }
  });

  console.log(`\n渠道配额模式验证：${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

await main();

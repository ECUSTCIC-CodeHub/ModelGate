// 验证会话亲和头 x-opencode-session 从入站请求透传到上游，且优先级低于渠道自定义 Header。
// 通过 mock 全局 fetch 抓取 buildUpstreamHeaders 的真实产出，不引入测试框架。
import { fetchUpstreamRequest } from "../lib/gateway/proxy.ts";

const captured = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  captured.push(new Headers(init?.headers));
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

function makeRoute({ protocol = "chat_completions", customHeaders = "" } = {}) {
  return {
    model: { id: 1, alias: "m", real_model: "real", token_multiplier: 1, request_multiplier: 1 },
    channel: {
      id: 1,
      name: "c",
      base_url: "https://up.example.com",
      api_key: "sk-up",
      timeout: 10,
      user_agent: null,
      proxy_url: null,
      custom_headers: customHeaders,
    },
    effective_upstream_protocol: protocol,
  };
}

async function call(route, headers) {
  captured.length = 0;
  await fetchUpstreamRequest(route, { model: "real" }, route.effective_upstream_protocol, new Headers(headers));
  return captured[0];
}

const cases = [];

const chatWithSession = await call(makeRoute(), { "x-opencode-session": "ses_abc123" });
cases.push(["chat_completions 透传", chatWithSession.get("x-opencode-session") === "ses_abc123"]);

const chatWithout = await call(makeRoute(), {});
cases.push(["无该头时不下发", chatWithout.has("x-opencode-session") === false]);

const anthropicWith = await call(makeRoute({ protocol: "anthropic_messages" }), { "x-opencode-session": "aff_1" });
cases.push(["anthropic_messages 透传", anthropicWith.get("x-opencode-session") === "aff_1"]);

const responsesWith = await call(makeRoute({ protocol: "responses" }), { "x-opencode-session": "aff_2" });
cases.push(["responses 透传", responsesWith.get("x-opencode-session") === "aff_2"]);

const custom = await call(
  makeRoute({ customHeaders: JSON.stringify({ "X-Opencode-Session": "channel_static" }) }),
  { "x-opencode-session": "ses_live" },
);
cases.push(["渠道自定义 Header 覆盖入站值", custom.get("x-opencode-session") === "channel_static"]);

const size = await call(makeRoute(), { "x-opencode-session": "ses_abc123" });
cases.push(["托管字段未被污染", size.get("user-agent") !== null && size.get("content-type") === "application/json"]);

let pass = 0;
for (const [name, ok] of cases) {
  if (ok) pass++;
  console.log(`${ok ? "✓" : "✗"} ${name}`);
}
globalThis.fetch = realFetch;
console.log(`\n${pass}/${cases.length} 通过`);
process.exit(pass === cases.length ? 0 : 1);

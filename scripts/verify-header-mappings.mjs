// 验证「请求头映射」：客户端头改名后发往上游，覆盖顺序与保存校验符合约定。
// 通过 mock 全局 fetch 抓取真实转发产出，不引入测试框架。
import { fetchUpstreamRequest } from "../lib/gateway/proxy.ts";
import { validateHeaderMappings, parseHeaderMappings, applyHeaderMappings } from "../lib/gateway/custom-headers.ts";

const captured = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  captured.push(new Headers(init?.headers));
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

function makeRoute({ protocol = "chat_completions", customHeaders = "", headerMappings = "" } = {}) {
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
      header_mappings: headerMappings,
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
const mapping = JSON.stringify([{ from: "x-session-id", to: "X-Opencode-Session" }]);

const renamed = await call(makeRoute({ headerMappings: mapping }), { "x-session-id": "sess-1" });
cases.push(["映射把客户端头改名下发", renamed.get("x-opencode-session") === "sess-1"]);

const missingSource = await call(makeRoute({ headerMappings: mapping }), {});
cases.push(["客户端没带源头时不下发", missingSource.has("x-opencode-session") === false]);

const noMapping = await call(makeRoute(), { "x-session-id": "sess-2" });
cases.push(["未配置映射时不凭空改名", noMapping.has("x-opencode-session") === false]);

const anthropicRenamed = await call(makeRoute({ protocol: "anthropic_messages", headerMappings: mapping }), { "x-session-id": "sess-3" });
cases.push(["anthropic_messages 同样生效", anthropicRenamed.get("x-opencode-session") === "sess-3"]);

const responsesRenamed = await call(makeRoute({ protocol: "responses", headerMappings: mapping }), { "x-session-id": "sess-4" });
cases.push(["responses 同样生效", responsesRenamed.get("x-opencode-session") === "sess-4"]);

const mappingWins = await call(
  makeRoute({ headerMappings: mapping, customHeaders: JSON.stringify({ "x-opencode-session": "channel_static" }) }),
  { "x-session-id": "sess_live" },
);
cases.push(["映射晚于自定义 Header，映射值胜出", mappingWins.get("x-opencode-session") === "sess_live"]);

const managedWins = await call(
  makeRoute({ headerMappings: JSON.stringify([{ from: "x-session-id", to: "user-agent" }]) }),
  { "x-session-id": "evil-agent" },
);
cases.push(["托管字段仍胜出", managedWins.get("user-agent") !== "evil-agent"]);

const authWins = await call(
  makeRoute({ headerMappings: JSON.stringify([{ from: "x-session-id", to: "authorization" }]) }),
  { "x-session-id": "Bearer stolen" },
);
cases.push(["鉴权头不被映射污染", authWins.get("authorization") === "Bearer sk-up"]);

cases.push(["目标为鉴权头时校验拒绝", validateHeaderMappings([{ from: "x-session-id", to: "authorization" }]).ok === false]);
cases.push(["名称非法时校验拒绝", validateHeaderMappings([{ from: "x session id", to: "x-a" }]).ok === false]);
cases.push(["不带连字符的名称被拒绝", validateHeaderMappings([{ from: "sessionid", to: "x-a" }]).ok === false]);
cases.push(["目标重复时校验拒绝", validateHeaderMappings([{ from: "x-a", to: "x-c" }, { from: "x-b", to: "X-C" }]).ok === false]);
cases.push(["超过 10 项校验拒绝", validateHeaderMappings(Array.from({ length: 11 }, (_, i) => ({ from: `x-a${i}`, to: `x-b${i}` }))).ok === false]);
cases.push(["空值与 null 视为未配置", validateHeaderMappings(null).ok && validateHeaderMappings([]).ok]);

const dirty = parseHeaderMappings(JSON.stringify([{ from: "x-a", to: "x-b" }, { from: "x-c", to: "host" }, "bad"]));
cases.push(["脏数据逐项丢弃", dirty.length === 1 && dirty[0].to === "x-b"]);

const overwriteTarget = new Headers({ "x-b": "client" });
applyHeaderMappings(overwriteTarget, [{ from: "x-a", to: "x-b" }], new Headers({ "x-a": "mapped" }));
cases.push(["映射覆盖客户端同名值", overwriteTarget.get("x-b") === "mapped"]);

// 历史数据或手改库值可能带着鉴权目标，运行期必须再挡一次，否则客户端值会写进鉴权头
const dirtyTarget = new Headers();
applyHeaderMappings(dirtyTarget, [{ from: "x-a", to: "Authorization" }], new Headers({ "x-a": "Bearer stolen" }));
cases.push(["运行期拦截鉴权目标", dirtyTarget.has("authorization") === false]);

let pass = 0;
for (const [name, ok] of cases) {
  if (ok) pass++;
  console.log(`${ok ? "✓" : "✗"} ${name}`);
}
globalThis.fetch = realFetch;
console.log(`\n${pass}/${cases.length} 通过`);
process.exit(pass === cases.length ? 0 : 1);

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

function makeRoute({ protocol = "chat_completions", customHeaders = "", headerMappings = "", apiKey = "sk-up" } = {}) {
  return {
    model: { id: 1, alias: "m", real_model: "real", token_multiplier: 1, request_multiplier: 1 },
    channel: {
      id: 1,
      name: "c",
      base_url: "https://up.example.com",
      api_key: apiKey,
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
cases.push(["两端都不带连字符时校验拒绝", validateHeaderMappings([{ from: "sessionid", to: "session" }]).ok === false]);
// 无连字符的真实头名（referer、origin、traceparent）改名是有意义的用法，只要求一端带连字符
cases.push(["无连字符的源可映射到带连字符的目标", validateHeaderMappings([{ from: "referer", to: "x-referer" }]).ok === true]);
cases.push(["带连字符的源可映射到无连字符的目标", validateHeaderMappings([{ from: "x-trace", to: "traceparent" }]).ok === true]);
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

// 手改库值不会经过保存校验，运行期拿到的是原始字符串：带空白或非法字符的名称
// 直接喂给 Headers.get/set 会抛错，而这个异常在 fetch 的 try 之外，会让整条转发永久 500
const paddedMapping = new Headers();
let paddedThrows = false;
try {
  applyHeaderMappings(paddedMapping, [{ from: " x-a ", to: " x-b " }], new Headers({ "x-a": "v" }));
} catch {
  paddedThrows = true;
}
cases.push(["库值名称带空白时不抛错", paddedThrows === false]);
cases.push(["库值名称带空白时仍能映射", paddedMapping.get("x-b") === "v"]);

const illegalMapping = new Headers();
let illegalThrows = false;
try {
  applyHeaderMappings(illegalMapping, [{ from: "x a", to: "x-b" }], new Headers({ "x-a": "v" }));
} catch {
  illegalThrows = true;
}
cases.push(["库值名称非法时不抛错", illegalThrows === false]);
cases.push(["库值名称非法时不下发", illegalMapping.has("x-b") === false]);

// 客户端可控值 + 上游按转发链元数据判权 = 提权通道，运行期与保存期都要挡
for (const hopHeader of ["x-forwarded-for", "x-real-ip", "x-forwarded-host", "cf-connecting-ip", "sec-fetch-site"]) {
  cases.push([`保存期拒绝 ${hopHeader}`, validateHeaderMappings([{ from: "x-a", to: hopHeader }]).ok === false]);
}
const hopTarget = new Headers();
applyHeaderMappings(hopTarget, [{ from: "x-a", to: "X-Forwarded-For" }], new Headers({ "x-a": "1.2.3.4" }));
cases.push(["运行期拦截转发链元数据目标", hopTarget.has("x-forwarded-for") === false]);

// 带了源头但值是空白，等于没带信息，不该凭空下发一个空目标头
const blankSource = await call(makeRoute({ headerMappings: mapping }), { "x-session-id": "   " });
cases.push(["源头值为空白时不下发", blankSource.has("x-opencode-session") === false]);

// 落位顺序里的另一条：映射的值压过渠道静态 custom_headers
const mappingOverStatic = await call(
  makeRoute({ headerMappings: JSON.stringify([{ from: "x-a", to: "x-b" }]), customHeaders: JSON.stringify({ "x-b": "static" }) }),
  { "x-a": "mapped" },
);
cases.push(["映射覆盖渠道静态自定义 Header", mappingOverStatic.get("x-b") === "mapped"]);

// 渠道没配密钥时托管鉴权头根本不存在，这是「后写覆盖」失效的唯一窗口：
// 此时若漏了运行期黑名单，客户端值就会被直接写进上游的鉴权头
const noKeyAuth = await call(
  makeRoute({ apiKey: "", headerMappings: JSON.stringify([{ from: "x-a", to: "authorization" }]) }),
  { "x-a": "Bearer stolen" },
);
cases.push(["无渠道密钥时鉴权头仍不被污染", noKeyAuth.has("authorization") === false]);

let pass = 0;
for (const [name, ok] of cases) {
  if (ok) pass++;
  console.log(`${ok ? "✓" : "✗"} ${name}`);
}
globalThis.fetch = realFetch;
console.log(`\n${pass}/${cases.length} 通过`);
process.exit(pass === cases.length ? 0 : 1);

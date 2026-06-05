import assert from "node:assert/strict";
import {
  responsesToolsToIntermediate,
  downgradeResponsesRequestForRoute,
  getResponsesRouteCompatibilityNote,
} from "../lib/gateway/protocol-adapters/tools";
import { createTransformedStream } from "../lib/gateway/protocol-adapters/streaming";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e: unknown) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- responsesToolsToIntermediate ---

console.log("\nresponsesToolsToIntermediate");

test("仅 function tools 正常转换", () => {
  const result = responsesToolsToIntermediate([
    { type: "function", name: "search", parameters: { type: "object", properties: {} } },
  ]);
  assert.equal(result?.length, 1);
  assert.equal(result?.[0].name, "search");
});

test("非 function tools 被忽略而非抛错", () => {
  const result = responsesToolsToIntermediate([
    { type: "function", name: "search", parameters: {} },
    { type: "namespace", name: "ns" },
    { type: "custom", name: "my_tool" },
  ]);
  assert.equal(result?.length, 1);
  assert.equal(result?.[0].name, "search");
});

test("全部为非 function tools 时返回 undefined", () => {
  const result = responsesToolsToIntermediate([
    { type: "namespace", name: "ns" },
    { type: "custom", name: "my_tool" },
  ]);
  assert.equal(result, undefined);
});

test("空数组返回 undefined", () => {
  assert.equal(responsesToolsToIntermediate([]), undefined);
});

test("undefined 输入返回 undefined", () => {
  assert.equal(responsesToolsToIntermediate(undefined), undefined);
});

// --- downgradeResponsesRequestForRoute ---

console.log("\ndowngradeResponsesRequestForRoute");

test("非 chat_completions 路由不做降级", () => {
  const body = {
    tools: [
      { type: "function", name: "search" },
      { type: "namespace", name: "ns" },
    ],
    tool_choice: "auto",
  };
  const result = downgradeResponsesRequestForRoute(body, "responses");
  assert.deepEqual(result, body);
});

test("chat_completions 路由只保留 function tools", () => {
  const body = {
    tools: [
      { type: "function", name: "search" },
      { type: "namespace", name: "ns" },
      { type: "custom", name: "my_tool" },
    ],
  };
  const result = downgradeResponsesRequestForRoute(body, "chat_completions");
  assert.equal((result.tools as unknown[]).length, 1);
  assert.equal((result.tools as Array<{ name: string }>)[0].name, "search");
});

test("chat_completions 路由无 function tools 时移除 tools", () => {
  const body = {
    tools: [
      { type: "namespace", name: "ns" },
      { type: "custom", name: "my_tool" },
    ],
  };
  const result = downgradeResponsesRequestForRoute(body, "chat_completions");
  assert.equal(result.tools, undefined);
});

test("chat_completions 路由移除无效 tool_choice", () => {
  const body = {
    tools: [
      { type: "namespace", name: "ns" },
    ],
    tool_choice: { type: "function", name: "ns" },
  };
  const result = downgradeResponsesRequestForRoute(body, "chat_completions");
  assert.equal(result.tool_choice, undefined);
});

test("chat_completions 路由保留 auto/none tool_choice", () => {
  const body = {
    tools: [{ type: "namespace", name: "ns" }],
    tool_choice: "auto",
  };
  const result = downgradeResponsesRequestForRoute(body, "chat_completions");
  assert.equal(result.tool_choice, "auto");
});

test("chat_completions 路由降级指向已移除 function 的 tool_choice", () => {
  const body = {
    tools: [
      { type: "function", name: "search" },
      { type: "custom", name: "other" },
    ],
    tool_choice: { type: "function", name: "other" },
  };
  const result = downgradeResponsesRequestForRoute(body, "chat_completions");
  assert.equal(result.tool_choice, "auto");
});

test("chat_completions 路由保留仍有效的 function tool_choice", () => {
  const body = {
    tools: [
      { type: "function", name: "search" },
      { type: "namespace", name: "ns" },
    ],
    tool_choice: { type: "function", name: "search" },
  };
  const result = downgradeResponsesRequestForRoute(body, "chat_completions");
  assert.deepEqual(result.tool_choice, { type: "function", name: "search" });
});

test("chat_completions 路由保留 required + 有 function tools", () => {
  const body = {
    tools: [
      { type: "function", name: "search" },
      { type: "namespace", name: "ns" },
    ],
    tool_choice: "required",
  };
  const result = downgradeResponsesRequestForRoute(body, "chat_completions");
  assert.equal(result.tool_choice, "required");
});

test("chat_completions 路由移除 required + 无 function tools", () => {
  const body = {
    tools: [
      { type: "namespace", name: "ns" },
    ],
    tool_choice: "required",
  };
  const result = downgradeResponsesRequestForRoute(body, "chat_completions");
  assert.equal(result.tool_choice, undefined);
});

test("chat_completions 路由无 tools 时移除 tool_choice", () => {
  const body = {
    tool_choice: { type: "function", name: "search" },
  };
  const result = downgradeResponsesRequestForRoute(body, "chat_completions");
  assert.equal(result.tool_choice, undefined);
});

// --- getResponsesRouteCompatibilityNote ---

console.log("\ngetResponsesRouteCompatibilityNote");

test("无 tools 时不返回 note", () => {
  assert.equal(getResponsesRouteCompatibilityNote({}, "chat_completions"), null);
});

test("全部为 function tools 时不返回 note", () => {
  assert.equal(
    getResponsesRouteCompatibilityNote(
      { tools: [{ type: "function", name: "a" }] },
      "chat_completions",
    ),
    null,
  );
});

test("有非 function tools 时返回 note", () => {
  const note = getResponsesRouteCompatibilityNote(
    { tools: [{ type: "function", name: "a" }, { type: "namespace", name: "b" }] },
    "chat_completions",
  );
  assert.ok(note?.includes("1 个非 function Responses tools"));
});

test("非 chat_completions 路由不返回 note", () => {
  assert.equal(
    getResponsesRouteCompatibilityNote(
      { tools: [{ type: "namespace", name: "b" }] },
      "responses",
    ),
    null,
  );
});

// --- createTransformedStream (responses -> responses uses decode/encode) ---

console.log("\ncreateTransformedStream (responses -> responses)");

function makeAdapter(protocol: string) {
  return {
    protocol,
    bodyAdapter: undefined,
    estimateRequestTokens: () => 0,
    countPromptTokens: () => 0,
    getStreamFlag: () => false,
    adaptRequestBody: (b: Record<string, unknown>) => b,
    adaptResponseBody: (t: string) => t,
    extractCompletionTextFromBody: () => "",
    extractReasoningTextFromBody: () => "",
    getUsageFromBody: () => null,
  } as unknown as import("../lib/gateway/protocol-adapters/runtime.ts").GatewayProtocolAdapter;
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function makeUpstreamResponsesStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
}

test("responses -> responses 流在缺少 response.completed 时补发完成事件", async () => {
  const upstream = makeUpstreamResponsesStream([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","output":[]}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
  ]);

  const adapter = makeAdapter("responses");
  const result = createTransformedStream(upstream, adapter, adapter);
  const output = await collectStream(result.stream);

  assert.ok(output.includes("response.created"), "应包含 response.created");
  assert.ok(output.includes("response.output_text.delta"), "应包含 delta");
  assert.ok(output.includes("response.completed"), "应补齐 response.completed");
});

test("responses -> responses 流在已有 response.completed 时不会重复", async () => {
  const upstream = makeUpstreamResponsesStream([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","output":[]}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","output":[]}}\n\n',
  ]);

  const adapter = makeAdapter("responses");
  const result = createTransformedStream(upstream, adapter, adapter);
  const output = await collectStream(result.stream);

  const completedCount = output.split("response.completed").length - 1;
  assert.ok(completedCount >= 1, "应包含至少一个 response.completed");
});

test("responses -> responses usage 统计正确", async () => {
  const upstream = makeUpstreamResponsesStream([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15},"output":[]}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15},"output":[]}}\n\n',
  ]);

  const adapter = makeAdapter("responses");
  const result = createTransformedStream(upstream, adapter, adapter);
  await collectStream(result.stream);
  const usage = result.usage();
  assert.ok(usage, "应有 usage");
  assert.equal(usage?.prompt_tokens, 10);
  assert.equal(usage?.completion_tokens, 5);
});

// --- Summary ---

console.log(`\n结果: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

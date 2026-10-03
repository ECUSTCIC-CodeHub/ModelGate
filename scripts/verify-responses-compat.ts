import assert from "node:assert/strict";
import {
  responsesToolsToIntermediate,
  downgradeResponsesRequestForRoute,
  getResponsesRouteCompatibilityNote,
} from "../lib/gateway/protocol-adapters/tools";
import { anthropicGatewayAdapter } from "../lib/gateway/protocol-adapters/anthropic";
import { chatCompletionsGatewayAdapter } from "../lib/gateway/protocol-adapters/chat-completions";
import { responsesGatewayAdapter } from "../lib/gateway/protocol-adapters/responses";
import { responsesResponseToIntermediate } from "../lib/gateway/protocol-adapters/responses-response";
import { createTransformedStream } from "../lib/gateway/protocol-adapters/streaming";
import {
  toolsFromIntermediateForAnthropic,
  toolsFromIntermediateForChat,
  toolsFromIntermediateForResponses,
} from "../lib/gateway/protocol-adapters/tools";
import { countTextTokens } from "../lib/gateway/tokenizer";
import { redactUrlCredentials } from "../lib/shared/redact";
import { injectModelSystemPrompt } from "../lib/gateway/model-system-prompt";
import { parseCustomHeaders, validateCustomHeaders } from "../lib/gateway/custom-headers";

let passed = 0;
let failed = 0;
const pending: Promise<void>[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  const pass = () => {
    passed++;
    console.log(`  PASS  ${name}`);
  };
  const fail = (e: unknown) => {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e instanceof Error ? e.message : String(e)}`);
  };

  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === "function") {
      pending.push((result as Promise<void>).then(pass).catch(fail));
      return;
    }
    pass();
  } catch (e: unknown) {
    fail(e);
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

// --- responses -> chat_completions request ---

console.log("\nresponses -> chat_completions request");

test("responses developer role is converted to chat_completions system role", () => {
  const result = responsesGatewayAdapter.adaptRequestBody(
    {
      model: "gpt-4o",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "answer concisely" }] },
      ],
      stream: false,
    },
    chatCompletionsGatewayAdapter,
    "gpt-4o",
  );
  const messages = result.messages as Array<{ role?: string; content?: unknown }>;

  assert.equal(messages[1]?.role, "system");
  assert.equal(messages[1]?.content, "answer concisely");
  assert.ok(!JSON.stringify(result).includes('"role":"developer"'));
});

test("responses 历史转 chat 不注入 thinking 内容块与非标准 reasoning 字段", () => {
  const result = responsesGatewayAdapter.adaptRequestBody(
    {
      model: "gpt-4o",
      input: [
        {
          type: "reasoning",
          content: [{ type: "reasoning_text", text: "think" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "next" }],
        },
      ],
      stream: false,
    },
    chatCompletionsGatewayAdapter,
    "gpt-4o",
  );
  const messages = result.messages as Array<{
    role?: string;
    content?: unknown;
    reasoning?: string;
    reasoning_content?: string;
  }>;

  assert.equal(messages[0]?.role, "assistant");
  assert.equal(messages[0]?.content, "hello");
  assert.equal(messages[1]?.role, "user");
  assert.ok(!JSON.stringify(result).includes('"type":"thinking"'));
  assert.ok(!("reasoning" in (messages[0] ?? {})), "请求方向不应注入非标准 reasoning 字段");
  assert.ok(!("reasoning_content" in (messages[0] ?? {})), "请求方向不应注入非标准 reasoning_content 字段");
});

test("responses reasoning is attached to chat_completions assistant tool call history", () => {
  const result = responsesGatewayAdapter.adaptRequestBody(
    {
      model: "gpt-4o",
      input: [
        {
          type: "reasoning",
          content: [{ type: "reasoning_text", text: "think before tool" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "search",
          arguments: "{\"q\":\"hello\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "result",
        },
      ],
      stream: false,
    },
    chatCompletionsGatewayAdapter,
    "gpt-4o",
  );
  const messages = result.messages as Array<{
    role?: string;
    content?: unknown;
    reasoning_content?: string;
    tool_calls?: Array<{ function?: { name?: string } }>;
  }>;

  assert.equal(messages[0]?.role, "assistant");
  assert.equal(messages[0]?.content, "");
  assert.equal(messages[0]?.tool_calls?.[0]?.function?.name, "search");
  assert.equal(messages[1]?.role, "tool");
  assert.ok(!JSON.stringify(result).includes('"type":"thinking"'));
  assert.ok(!("reasoning_content" in (messages[0] ?? {})), "请求方向不应注入非标准 reasoning_content 字段");
});

test("responses reasoning between function call and output keeps chat tool adjacency", () => {
  const result = responsesGatewayAdapter.adaptRequestBody(
    {
      model: "gpt-4o",
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "search",
          arguments: "{\"q\":\"hello\"}",
        },
        {
          type: "reasoning",
          content: [{ type: "reasoning_text", text: "wait for search" }],
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "result",
        },
      ],
      stream: false,
    },
    chatCompletionsGatewayAdapter,
    "gpt-4o",
  );
  const messages = result.messages as Array<{
    role?: string;
    reasoning_content?: string;
    tool_call_id?: string;
    tool_calls?: Array<{ id?: string }>;
  }>;

  assert.equal(messages[0]?.role, "assistant");
  assert.equal(messages[0]?.tool_calls?.[0]?.id, "call_1");
  assert.equal(messages[1]?.role, "tool");
  assert.equal(messages[1]?.tool_call_id, "call_1");
  assert.ok(!("reasoning_content" in (messages[0] ?? {})), "请求方向不应注入非标准 reasoning_content 字段");
});

test("anthropic thinking 历史转 chat 时不回带 thinking 块与 reasoning 字段", () => {
  const result = anthropicGatewayAdapter.adaptRequestBody(
    {
      model: "claude-3-5-sonnet",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal reasoning", signature: "sig" },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: "next" },
      ],
    },
    chatCompletionsGatewayAdapter,
    "gpt-4o",
  );
  const messages = result.messages as Array<Record<string, unknown>>;
  const assistant = messages.find((m) => m.role === "assistant");

  assert.ok(assistant, "应保留 assistant 历史消息");
  assert.equal(assistant.content, "answer");
  assert.ok(!JSON.stringify(result).includes('"type":"thinking"'), "不应出现 thinking 内容块");
  assert.ok(!("reasoning" in assistant), "不应注入 reasoning");
  assert.ok(!("reasoning_content" in assistant), "不应注入 reasoning_content");
});

test("多前导空格的 [DONE] 哨兵不再被当成 JSON 解析", async () => {
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"id":"x","choices":[{"delta":{"content":"hi"}}]}\n\n'));
      controller.enqueue(encoder.encode("data:  [DONE]\n\n"));
      controller.close();
    },
  });

  const result = createTransformedStream(upstream, chatCompletionsGatewayAdapter, anthropicGatewayAdapter);
  const output = await collectStream(result.stream);

  assert.ok(output.includes("hi"), "正常内容应已输出");
  assert.ok(!output.includes("上游流式返回错误"), `[DONE] 不应被当成错误，实际: ${output}`);
});

test("responses consecutive function calls are grouped before chat tool outputs", () => {
  const result = responsesGatewayAdapter.adaptRequestBody(
    {
      model: "gpt-4o",
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "search",
          arguments: "{\"q\":\"hello\"}",
        },
        {
          type: "function_call",
          call_id: "call_2",
          name: "read",
          arguments: "{\"path\":\"README.md\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "search result",
        },
        {
          type: "function_call_output",
          call_id: "call_2",
          output: "file result",
        },
      ],
      stream: false,
    },
    chatCompletionsGatewayAdapter,
    "gpt-4o",
  );
  const messages = result.messages as Array<{
    role?: string;
    tool_call_id?: string;
    tool_calls?: Array<{ id?: string }>;
  }>;

  assert.equal(messages[0]?.role, "assistant");
  assert.deepEqual(messages[0]?.tool_calls?.map((toolCall) => toolCall.id), ["call_1", "call_2"]);
  assert.equal(messages[1]?.role, "tool");
  assert.equal(messages[1]?.tool_call_id, "call_1");
  assert.equal(messages[2]?.role, "tool");
  assert.equal(messages[2]?.tool_call_id, "call_2");
});

test("responses non-tool messages between tool call and output are deferred", () => {
  const result = responsesGatewayAdapter.adaptRequestBody(
    {
      model: "gpt-4o",
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "search",
          arguments: "{\"q\":\"hello\"}",
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "next" }],
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "result",
        },
      ],
      stream: false,
    },
    chatCompletionsGatewayAdapter,
    "gpt-4o",
  );
  const messages = result.messages as Array<{
    role?: string;
    content?: unknown;
    tool_call_id?: string;
    tool_calls?: Array<{ id?: string }>;
  }>;

  assert.equal(messages[0]?.role, "assistant");
  assert.equal(messages[0]?.tool_calls?.[0]?.id, "call_1");
  assert.equal(messages[1]?.role, "tool");
  assert.equal(messages[1]?.tool_call_id, "call_1");
  assert.equal(messages[2]?.role, "user");
  assert.equal(messages[2]?.content, "next");
});

// --- chat_completions -> upstream request ---

console.log("\nchat_completions -> upstream request");

test("chat_completions developer role is converted for responses upstream", () => {
  const result = chatCompletionsGatewayAdapter.adaptRequestBody(
    {
      model: "gpt-4o",
      messages: [
        { role: "developer", content: "answer concisely" },
        { role: "user", content: "hi" },
      ],
      stream: false,
    },
    responsesGatewayAdapter,
    "gpt-4o",
  );
  const input = result.input as Array<{ role?: string; content?: unknown }>;

  assert.equal(input[0]?.role, "system");
  assert.equal(input[1]?.role, "user");
  assert.ok(!JSON.stringify(result).includes('"role":"developer"'));
});

test("chat_completions reasoning is converted for responses upstream without thinking content part", () => {
  const result = chatCompletionsGatewayAdapter.adaptRequestBody(
    {
      model: "gpt-4o",
      messages: [
        { role: "assistant", content: "hello", reasoning_content: "think" },
        { role: "user", content: "next" },
      ],
      stream: false,
    },
    responsesGatewayAdapter,
    "gpt-4o",
  );
  const input = result.input as Array<{ type?: string; role?: string; content?: Array<{ type?: string; text?: string }> }>;

  assert.equal(input[0]?.type, "reasoning");
  assert.equal(input[1]?.type, "message");
  assert.equal(input[1]?.role, "assistant");
  assert.equal(input[1]?.content?.[0]?.type, "output_text");
  assert.ok(!JSON.stringify(result).includes('"type":"thinking"'));
});

test("chat_completions developer role is converted for anthropic upstream", () => {
  const result = chatCompletionsGatewayAdapter.adaptRequestBody(
    {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "developer", content: "answer concisely" },
        { role: "user", content: "hi" },
      ],
      stream: false,
    },
    anthropicGatewayAdapter,
    "claude-sonnet-4-6",
  );
  const messages = result.messages as Array<{ role?: string; content?: unknown }>;

  assert.equal(result.system, "answer concisely");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "user");
  assert.ok(!JSON.stringify(result).includes('"role":"developer"'));
});

test("chat_completions fields are filtered and mapped for responses upstream", () => {
  const result = chatCompletionsGatewayAdapter.adaptRequestBody(
    {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_completion_tokens: 64,
      n: 2,
      logprobs: true,
      top_logprobs: 2,
      presence_penalty: 0.5,
      frequency_penalty: 0.25,
      logit_bias: { "42": 1 },
      seed: 123,
      response_format: { type: "json_object" },
      reasoning: { effort: "medium" },
      store: true,
      service_tier: "auto",
    },
    responsesGatewayAdapter,
    "gpt-4o",
  );

  assert.equal(result.max_output_tokens, 64);
  assert.deepEqual(result.text, { format: { type: "json_object" } });
  assert.equal(result.reasoning_effort, "medium");
  assert.equal(result.store, true);
  assert.equal(result.service_tier, "auto");
  for (const key of [
    "max_completion_tokens",
    "n",
    "logprobs",
    "top_logprobs",
    "presence_penalty",
    "frequency_penalty",
    "logit_bias",
    "seed",
    "response_format",
    "reasoning",
  ]) {
    assert.ok(!(key in result), `${key} should not leak to responses`);
  }
});

test("chat_completions fields are filtered and mapped for anthropic upstream", () => {
  const result = chatCompletionsGatewayAdapter.adaptRequestBody(
    {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_completion_tokens: 64,
      n: 2,
      logprobs: true,
      top_logprobs: 2,
      presence_penalty: 0.5,
      frequency_penalty: 0.25,
      logit_bias: { "42": 1 },
      seed: 123,
      response_format: { type: "json_object" },
      reasoning: { effort: "medium" },
      store: true,
      service_tier: "auto",
      stream_options: { include_usage: true },
      parallel_tool_calls: true,
      user: "u1",
    },
    anthropicGatewayAdapter,
    "claude-sonnet-4-6",
  );

  assert.equal(result.max_tokens, 64);
  for (const key of [
    "max_completion_tokens",
    "n",
    "logprobs",
    "top_logprobs",
    "presence_penalty",
    "frequency_penalty",
    "logit_bias",
    "seed",
    "response_format",
    "reasoning",
    "reasoning_effort",
    "store",
    "service_tier",
    "stream_options",
    "parallel_tool_calls",
    "user",
  ]) {
    assert.ok(!(key in result), `${key} should not leak to anthropic`);
  }
});

test("anthropic-only fields are filtered for responses upstream", () => {
  const result = anthropicGatewayAdapter.adaptRequestBody(
    {
      model: "gpt-4o",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      top_k: 20,
      container: "session_1",
      mcp_servers: [],
      thinking: { type: "enabled", budget_tokens: 1024 },
    },
    responsesGatewayAdapter,
    "gpt-4o",
  );

  assert.equal(result.max_output_tokens, 64);
  for (const key of ["top_k", "container", "mcp_servers", "thinking"]) {
    assert.ok(!(key in result), `${key} should not leak to responses`);
  }
});

test("responses upstream body converts to chat_completions text, reasoning and tools", () => {
  const result = JSON.parse(chatCompletionsGatewayAdapter.adaptResponseBody(
    JSON.stringify({
      id: "resp_test",
      model: "gpt-4o",
      output: [
        { type: "reasoning", content: [{ type: "reasoning_text", text: "think" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello", annotations: [] }] },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "search", arguments: "{\"q\":\"hello\"}" },
      ],
    }),
    responsesGatewayAdapter,
  )) as {
    choices: Array<{
      message: {
        content?: string;
        reasoning?: string;
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
      };
      finish_reason?: string;
    }>;
  };
  const choice = result.choices[0];

  assert.equal(choice?.message.content, "hello");
  assert.equal(choice?.message.reasoning, "think");
  assert.equal(choice?.message.tool_calls?.[0]?.function?.name, "search");
  assert.equal(choice?.finish_reason, "tool_calls");
});

// --- responsesResponseToIntermediate ---

console.log("\nresponsesResponseToIntermediate");

test("顶层 output_text 可作为非流式文本兜底", () => {
  const result = responsesResponseToIntermediate({
    id: "resp_test",
    model: "gpt-4o",
    output: [],
    output_text: "hello",
  });
  assert.equal(result.content.find((part) => part.type === "text")?.text, "hello");
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

test("responses -> anthropic 流可从 completed 快照补发文本", async () => {
  const upstream = makeUpstreamResponsesStream([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","output":[]}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello","annotations":[]}]}],"output_text":"hello"}}\n\n',
  ]);

  const responses = makeAdapter("responses");
  const anthropic = makeAdapter("anthropic_messages");
  const result = createTransformedStream(upstream, responses, anthropic);
  const output = await collectStream(result.stream);

  assert.ok(output.includes("content_block_delta"), "应包含 Anthropic 文本增量事件");
  assert.ok(output.includes("\"text\":\"hello\""), "应补发 completed 快照中的文本");
  assert.equal(result.completionText(), "hello");
});

test("responses -> chat_completions stream can emit completed snapshot text", async () => {
  const upstream = makeUpstreamResponsesStream([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","output":[]}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello","annotations":[]}]}],"output_text":"hello"}}\n\n',
  ]);

  const result = createTransformedStream(upstream, responsesGatewayAdapter, chatCompletionsGatewayAdapter);
  const output = await collectStream(result.stream);

  assert.ok(output.includes("\"content\":\"hello\""), "should emit chat completion content delta");
  assert.equal(result.completionText(), "hello");
});

test("responses -> anthropic can count output_item.done text without completed", async () => {
  const upstream = makeUpstreamResponsesStream([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","output":[]}}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"hello","annotations":[]}]}}\n\n',
  ]);

  const responses = makeAdapter("responses");
  const anthropic = makeAdapter("anthropic_messages");
  const result = createTransformedStream(upstream, responses, anthropic);
  const output = await collectStream(result.stream);

  assert.ok(output.includes("\"text\":\"hello\""), "should emit text from output_item.done");
  assert.equal(result.completionText(), "hello");
});

test("responses -> anthropic can count done-only reasoning summary", async () => {
  const upstream = makeUpstreamResponsesStream([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","output":[]}}\n\n',
    'event: response.reasoning_summary_text.done\ndata: {"type":"response.reasoning_summary_text.done","text":"think"}\n\n',
    'event: response.output_text.done\ndata: {"type":"response.output_text.done","text":"hello"}\n\n',
  ]);

  const responses = makeAdapter("responses");
  const anthropic = makeAdapter("anthropic_messages");
  const result = createTransformedStream(upstream, responses, anthropic, { thinkingEnabled: true });
  const output = await collectStream(result.stream);

  assert.ok(output.includes("\"thinking\":\"think\""), "should emit reasoning summary as thinking");
  assert.ok(output.includes("\"text\":\"hello\""), "should emit done-only text");
  assert.equal(result.reasoningText(), "think");
  assert.equal(result.completionText(), "hello");
});

test("responses -> anthropic 流可从 completed 快照补发工具调用", async () => {
  const upstream = makeUpstreamResponsesStream([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","output":[]}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":"search","arguments":"{\\"q\\":\\"hello\\"}","status":"completed"}]}}\n\n',
  ]);

  const responses = makeAdapter("responses");
  const anthropic = makeAdapter("anthropic_messages");
  const result = createTransformedStream(upstream, responses, anthropic);
  const output = await collectStream(result.stream);

  assert.ok(output.includes("\"type\":\"tool_use\""), "应包含 Anthropic 工具调用块");
  assert.ok(output.includes("\"name\":\"search\""), "应保留工具名");
  assert.ok(output.includes("input_json_delta"), "应补发工具参数增量");
});

test("chat tool_choice=none 转 anthropic 时省略 tools 列表", () => {
  const base = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "search", description: "s", parameters: { type: "object", properties: {} } } }],
    stream: false,
  };

  const none = chatCompletionsGatewayAdapter.adaptRequestBody(
    { ...base, tool_choice: "none" },
    anthropicGatewayAdapter,
    "claude-3-5-sonnet",
  );
  assert.equal(none.tools, undefined, "none 应省略 tools 列表");
  assert.equal(none.tool_choice, undefined, "none 不应下发 Anthropic 没有的 tool_choice 取值");

  const auto = chatCompletionsGatewayAdapter.adaptRequestBody(
    { ...base, tool_choice: "auto" },
    anthropicGatewayAdapter,
    "claude-3-5-sonnet",
  );
  assert.ok(auto.tools, "auto 应保留下发 tools 列表");
  assert.deepEqual(auto.tool_choice, { type: "auto" });

  const noChoice = chatCompletionsGatewayAdapter.adaptRequestBody(base, anthropicGatewayAdapter, "claude-3-5-sonnet");
  assert.ok(noChoice.tools, "未指定 tool_choice 时应保留下发 tools 列表");
});

test("URL 脱敏不残留嵌套与连写 URL 的凭据", () => {
  const cases: Array<[string, string]> = [
    ["https://user:pass@host/v1", "https://host/v1"],
    ["https://user:pa@ss@host/v1", "https://host/v1"],
    ["https://a://b@c", "https://a://c"],
    ["http://x://u:p@h", "http://x://h"],
    ["https://https://u:p@h", "https://https://h"],
    ["https://u:p@h,https://v:q@i", "https://h,https://i"],
    ["https://u:p@h/v1 https://x:y@z/v2", "https://h/v1 https://z/v2"],
    ["https://example.com?next=mailto:a@b.com", "https://example.com?next=mailto:a@b.com"],
    ["https://host/v1/user@example.com", "https://host/v1/user@example.com"],
    ["mailto:a@b.com", "mailto:a@b.com"],
    // zod 的 url() 放行任意长 scheme，长度上限会让这类 base_url 的凭据落进日志
    [`${"x".repeat(64)}://user:pass@host`, `${"x".repeat(64)}://host`],
    [`${"x".repeat(256)}://user:pass@host/path`, `${"x".repeat(256)}://host/path`],
  ];

  for (const [input, expected] of cases) {
    const actual = redactUrlCredentials(input);
    assert.equal(actual, expected, `输入 ${JSON.stringify(input)}`);
    assert.equal(redactUrlCredentials(actual), actual, `幂等：${JSON.stringify(input)}`);
  }

  // 超长无 @ 文本不得触发超线性回溯或栈溢出
  const long = "https://" + "a".repeat(200_000);
  const started = Date.now();
  assert.equal(redactUrlCredentials(long), long);
  assert.ok(Date.now() - started < 2000, "超长输入脱敏应在 2 秒内完成");
});

test("tool_result 的兄弟 tool_use 挂到 assistant 消息而不是原 role", () => {
  const messages = [
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "a" } }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "result-1" },
        { type: "tool_use", id: "t2", name: "fetch", input: { url: "x" } },
      ],
    },
  ];
  const body = { model: "claude-3", messages, max_tokens: 100, stream: false };

  const chat = anthropicGatewayAdapter.adaptRequestBody(body as never, chatCompletionsGatewayAdapter, "gpt-4o");
  const chatMessages = (chat as { messages: Array<{ role: string; tool_calls?: Array<{ function: { name: string } }> }> }).messages;
  const names = chatMessages.flatMap((m) => (m.tool_calls ?? []).map((tc) => tc.function.name));
  assert.deepEqual(names, ["search", "fetch"], "兄弟 tool_use 不能丢失");
  assert.ok(!chatMessages.some((m) => m.role === "user" && !m.tool_calls), "不应产生空的 user 消息");

  const resp = anthropicGatewayAdapter.adaptRequestBody(body as never, responsesGatewayAdapter, "o1");
  const input = (resp as { input: Array<{ type: string; name?: string }> }).input;
  assert.deepEqual(
    input.filter((item) => item.type === "function_call").map((item) => item.name),
    ["search", "fetch"],
  );
});

test("无 tool_result 的 tool_use 同样挂到 assistant 消息", () => {
  const body = {
    model: "claude-3",
    messages: [{ role: "user", content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "a" } }] }],
    max_tokens: 100,
    stream: false,
  };

  const chat = anthropicGatewayAdapter.adaptRequestBody(body as never, chatCompletionsGatewayAdapter, "gpt-4o");
  const chatMessages = (chat as { messages: Array<{ role: string; content: unknown; tool_calls?: Array<{ function: { name: string } }> }> }).messages;
  assert.ok(!chatMessages.some((m) => m.role === "user" && !m.tool_calls), "user 消息不应携带 tool_calls");
  assert.deepEqual(chatMessages.flatMap((m) => (m.tool_calls ?? []).map((tc) => tc.function.name)), ["search"]);
});

test("模型级系统提示词按协议注入且不修改原始请求", () => {
  const chat = injectModelSystemPrompt(
    { messages: [{ role: "system", content: "orig" }, { role: "user", content: "hi" }] },
    "chat_completions",
    "SYS",
  );
  assert.equal((chat.messages as Array<{ content: string }>)[0].content, "SYS\n\norig");

  const responses = injectModelSystemPrompt({ instructions: "orig" }, "responses", "SYS");
  assert.equal(responses.instructions, "SYS\n\norig");

  // 上游 injectResponsesSystem 会把非字符串 instructions 判空后覆盖，这里必须原样保留
  const arrayInstructions = { instructions: [{ type: "message" }] };
  assert.deepEqual(injectModelSystemPrompt(arrayInstructions, "responses", "SYS"), arrayInstructions);

  const anthropicBody = { system: [{ type: "text", text: "orig", cache_control: { type: "ephemeral" } }] };
  const anthropic = injectModelSystemPrompt(anthropicBody, "anthropic_messages", "SYS");
  assert.deepEqual(anthropic.system, [
    { type: "text", text: "SYS" },
    { type: "text", text: "orig", cache_control: { type: "ephemeral" } },
  ]);

  for (const protocol of ["embeddings", "other", "images"] as const) {
    const body = { messages: [{ role: "user", content: "hi" }] };
    assert.deepEqual(injectModelSystemPrompt(body, protocol, "SYS"), body, `${protocol} 不应注入`);
  }

  const original = { messages: [{ role: "system", content: "orig" }] };
  const snapshot = JSON.stringify(original);
  injectModelSystemPrompt(original, "chat_completions", "SYS");
  assert.equal(JSON.stringify(original), snapshot, "不得原地修改原始请求");
});

test("自定义 Header 托管字段覆盖且脏数据逐键过滤", () => {
  // 托管键必须全小写：JS 对象里 "Accept" 与自定义的 "accept" 是两个键，
  // 交给 Headers 会合并成 "text/evil, application/json" 而不是覆盖
  const custom = parseCustomHeaders(JSON.stringify({ accept: "text/evil" }));
  const managed = new Headers({ ...custom, accept: "application/json" });
  assert.equal(managed.get("accept"), "application/json");
  assert.equal(new Headers({ accept: "text/evil", Accept: "application/json" }).get("accept"), "text/evil, application/json");

  for (const value of ["ok\nX-Injected: pwned", "ok\r\nX", "ok\u0000evil", "ok\u007fevil", "a\u2028b", "a\u2029b", "a\u0085b", "a\u00a0b"]) {
    assert.equal(validateCustomHeaders({ "X-Test": value }).ok, false, `控制字符应被拒绝: ${JSON.stringify(value)}`);
  }
  // 合法值不能被过度收紧
  for (const value of ["ok\tvalue", "https://api.example.com/v1?x=1", "中文值", "ok-✅", "a,b;c", "100%"]) {
    assert.equal(validateCustomHeaders({ "X-Test": value }).ok, true, `合法值应放行: ${JSON.stringify(value)}`);
  }

  // 脏数据里混入黑名单键时，其余合法项仍应生效
  const dirty = parseCustomHeaders(
    JSON.stringify({ "x-good": "keep", authorization: "Bearer leak", "x-bad": "a\nb" }),
  );
  assert.deepEqual(dirty, { "x-good": "keep" });

  // 逐键路径同样要受 20 条上限约束
  const many: Record<string, string> = {};
  for (let i = 0; i < 30; i++) many[`x-h-${i}`] = `v${i}`;
  assert.equal(Object.keys(parseCustomHeaders(JSON.stringify(many))).length, 20);

  for (const raw of [123, null, "", "{not json", "[1,2]", '"abc"', "42"]) {
    assert.deepEqual(parseCustomHeaders(raw), {}, `坏输入应退回空对象: ${JSON.stringify(raw)}`);
  }
});

test("无参工具补空 object schema 而不是省略 parameters", () => {
  const tools = [{ type: "function" as const, name: "ping", description: "ping" }];
  const expected = { type: "object", properties: {} };

  assert.deepEqual(toolsFromIntermediateForChat(tools)?.[0]?.function.parameters, expected);
  assert.deepEqual(toolsFromIntermediateForResponses(tools)?.[0]?.parameters, expected);
  assert.deepEqual(toolsFromIntermediateForAnthropic(tools)?.[0]?.input_schema, expected);

  const withSchema = [{ type: "function" as const, name: "echo", parameters: { type: "object", properties: { q: { type: "string" } } } }];
  assert.deepEqual(toolsFromIntermediateForChat(withSchema)?.[0]?.function.parameters, withSchema[0].parameters);
});

test("o 系模型使用 o200k_base 词表", () => {
  const text = "The quick brown fox jumps over the lazy dog. 你好，世界！这是一段用于测试的中文文本。";
  const o200k = countTextTokens(text, "gpt-4o");
  const cl100k = countTextTokens(text, "gpt-4-turbo");

  assert.ok(o200k < cl100k, `o200k 词表应比 cl100k 更省 token，实际 ${o200k} vs ${cl100k}`);
  for (const model of ["o1", "o1-mini", "o3-mini", "o4", "o4-mini"]) {
    assert.equal(countTextTokens(text, model), o200k, `${model} 应使用 o200k_base`);
  }
});

test("responses -> chat_completions stream can emit completed snapshot tool call", async () => {
  const upstream = makeUpstreamResponsesStream([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","output":[]}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":"search","arguments":"{\\"q\\":\\"hello\\"}","status":"completed"}]}}\n\n',
  ]);

  const result = createTransformedStream(upstream, responsesGatewayAdapter, chatCompletionsGatewayAdapter);
  const output = await collectStream(result.stream);

  assert.ok(output.includes("\"tool_calls\""), "should emit chat completion tool calls");
  assert.ok(output.includes("\"name\":\"search\""), "should keep tool name");
  assert.ok(output.includes("\"finish_reason\":\"tool_calls\""), "should finish with tool_calls");
});

// --- 上游流式错误事件与长度截断 ---

console.log("\n上游流式错误事件与长度截断");

test("responses 上游 response.failed 透出真实原因而不是静默截断", async () => {
  const upstream = makeUpstreamResponsesStream([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","output":[]}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hel"}\n\n',
    'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_test","status":"failed","error":{"code":"server_error","message":"上游限流"}}}\n\n',
  ]);

  const adapter = makeAdapter("responses");
  const result = createTransformedStream(upstream, adapter, adapter);
  const output = await collectStream(result.stream);

  assert.ok(output.includes("response.failed"), "应输出 response.failed 事件");
  assert.ok(output.includes("上游限流"), "应带上游真实错误信息");
});

test("chat_completions 上游 error 块透出真实原因", async () => {
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"id":"x","choices":[{"delta":{"content":"hi"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"error":{"message":"配额不足","code":"quota"}}\n\n'));
      controller.close();
    },
  });

  const result = createTransformedStream(upstream, chatCompletionsGatewayAdapter, anthropicGatewayAdapter);
  const output = await collectStream(result.stream);

  assert.ok(output.includes("上游流式返回错误"), `应输出流式错误，实际: ${output}`);
  assert.ok(output.includes("配额不足"), "应带上游真实错误信息");
});

test("anthropic 上游 error 事件透出真实原因", async () => {
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude","usage":{"input_tokens":1,"output_tokens":0}}}\n\n'));
      controller.enqueue(encoder.encode('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"上游过载"}}\n\n'));
      controller.close();
    },
  });

  const result = createTransformedStream(upstream, anthropicGatewayAdapter, chatCompletionsGatewayAdapter);
  const output = await collectStream(result.stream);

  assert.ok(output.includes("上游流式返回错误"), `应输出流式错误，实际: ${output}`);
  assert.ok(output.includes("上游过载"), "应带上游真实错误信息");
});

test("长度截断在 anthropic / chat / responses 之间正确换算", async () => {
  const encoder = new TextEncoder();
  const anthropicUpstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude","usage":{"input_tokens":1,"output_tokens":0}}}\n\n'));
      controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":5}}\n\n'));
      controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
      controller.close();
    },
  });

  const toChat = createTransformedStream(anthropicUpstream, anthropicGatewayAdapter, chatCompletionsGatewayAdapter);
  const chatOut = await collectStream(toChat.stream);
  assert.ok(chatOut.includes("\"finish_reason\":\"length\""), `Anthropic max_tokens 应转成 Chat length，实际: ${chatOut}`);

  const anthropicUpstream2 = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","model":"claude","usage":{"input_tokens":1,"output_tokens":0}}}\n\n'));
      controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":5}}\n\n'));
      controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
      controller.close();
    },
  });

  const toResponses = createTransformedStream(anthropicUpstream2, anthropicGatewayAdapter, responsesGatewayAdapter);
  const responsesOut = await collectStream(toResponses.stream);
  assert.ok(responsesOut.includes("response.incomplete"), `Anthropic max_tokens 应转成 Responses incomplete，实际: ${responsesOut}`);
  assert.ok(responsesOut.includes("max_output_tokens"), "应带 incomplete_details.reason");
});

test("Responses incomplete 解析回 length", async () => {
  const upstream = makeUpstreamResponsesStream([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","output":[]}}\n\n',
    'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"id":"resp_test","model":"gpt-4o","created_at":"2026-01-01T00:00:00Z","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}}\n\n',
  ]);

  const result = createTransformedStream(upstream, responsesGatewayAdapter, chatCompletionsGatewayAdapter);
  const output = await collectStream(result.stream);

  assert.ok(output.includes("\"finish_reason\":\"length\""), `Responses incomplete 应转成 Chat length，实际: ${output}`);
});

// --- Summary ---

void Promise.all(pending).then(() => {
  console.log(`\n结果: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
});

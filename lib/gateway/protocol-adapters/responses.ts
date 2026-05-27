import {
  asArray,
  asRecord,
  extractThinkingText,
  normalizeContentParts,
  normalizeResponsesInput,
  normalizedPartsToResponseContent,
  type JsonRecord,
} from "@/lib/gateway/normalized-message";
import {
  normalizeUsage,
  omitKeys,
  type ProtocolBodyAdapter,
} from "@/lib/gateway/protocol-adapters/intermediate";
import {
  responsesToolChoiceToIntermediate,
  responsesToolsToIntermediate,
  toolChoiceFromIntermediateForResponses,
  toolsFromIntermediateForResponses,
} from "@/lib/gateway/protocol-adapters/tools";
import { createBodyProtocolGatewayAdapter, inputTextFromMessages } from "@/lib/gateway/protocol-adapters/runtime";

const REQUEST_KEYS = [
  "model",
  "input",
  "instructions",
  "stream",
  "max_output_tokens",
  "temperature",
  "top_p",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream_options",
  "user",
  "metadata",
  "text",
];

const RESPONSE_KEYS = ["id", "object", "created_at", "created", "status", "error", "incomplete_details", "model", "output", "output_text", "usage"];

export function extractResponsesMessage(output: unknown) {
  const items = asArray(output).map((item) => asRecord(item)).filter((item): item is JsonRecord => Boolean(item));
  const messageItems = items.filter((item) => item.type === "message" && item.role === "assistant");
  const functionCalls = items.filter((item) => item.type === "function_call");
  const reasoningItems = items.filter((item) => item.type === "reasoning");

  const text = messageItems
    .flatMap((item) => normalizeContentParts(item.content))
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

  const toolCalls = functionCalls.map((item) => ({
    id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : undefined,
    name: typeof item.name === "string" ? item.name : "",
    arguments: typeof item.arguments === "string" ? item.arguments : "",
  }));

  const reasoning = reasoningItems
    .flatMap((item) => normalizeContentParts(item.content))
    .filter((part) => part.type === "thinking")
    .map((part) => part.thinking)
    .join("");

  return { text, toolCalls, reasoning };
}

function createdToUnix(value: unknown) {
  const created = typeof value === "string"
    ? Math.floor(new Date(value).getTime() / 1000)
    : Number(value);
  return Number.isFinite(created) ? created : Math.floor(Date.now() / 1000);
}

export const responsesAdapter: ProtocolBodyAdapter = {
  requestToIntermediate(body, realModel) {
    return {
      sourceProtocol: "responses",
      model: realModel,
      messages: normalizeResponsesInput(body.input, typeof body.instructions === "string" ? body.instructions : undefined),
      stream: body.stream === true,
      maxTokens: body.max_output_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      tools: body.tools !== undefined ? responsesToolsToIntermediate(body.tools) : undefined,
      tool_choice: body.tool_choice !== undefined ? responsesToolChoiceToIntermediate(body.tool_choice) : undefined,
      parallel_tool_calls: body.parallel_tool_calls,
      stream_options: body.stream_options,
      user: body.user,
      metadata: body.metadata,
      text: body.text,
      extra: omitKeys(body, REQUEST_KEYS),
    };
  },

  requestFromIntermediate(request) {
    const next: JsonRecord = {
      ...request.extra,
      model: request.model,
      input: request.messages.flatMap((message) => {
        const items: JsonRecord[] = [];
        const reasoningText = message.role === "assistant" ? extractThinkingText(message.content) : "";
        if (reasoningText) {
          items.push({
            type: "reasoning",
            summary: [],
            content: [{ type: "reasoning_text", text: reasoningText }],
          });
        }

        if (message.role !== "tool" && (message.content.length > 0 || message.role !== "assistant")) {
          items.push({
            type: "message",
            role: message.role,
            content: normalizedPartsToResponseContent(message.content, message.role),
          });
        }

        for (const toolCall of message.tool_calls ?? []) {
          items.push({
            type: "function_call",
            call_id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments ?? "",
          });
        }

        if (message.role === "tool" && message.tool_call_id) {
          items.push({
            type: "function_call_output",
            call_id: message.tool_call_id,
            output: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
          });
        }

        return items;
      }),
      stream: request.stream,
    };

    if (request.temperature !== undefined) next.temperature = request.temperature;
    if (request.top_p !== undefined) next.top_p = request.top_p;
    if (request.maxTokens !== undefined) next.max_output_tokens = request.maxTokens;
    if (request.tools !== undefined) next.tools = toolsFromIntermediateForResponses(request.tools);
    if (request.tool_choice !== undefined) next.tool_choice = toolChoiceFromIntermediateForResponses(request.tool_choice);
    if (request.parallel_tool_calls !== undefined) next.parallel_tool_calls = request.parallel_tool_calls;
    if (request.stream_options !== undefined) next.stream_options = request.stream_options;
    if (request.user !== undefined) next.user = request.user;
    if (request.metadata !== undefined) next.metadata = request.metadata;
    if (request.text !== undefined) next.text = request.text;

    return next;
  },

  responseToIntermediate(body) {
    const extracted = extractResponsesMessage(body.output);
    const usage = asRecord(body.usage);
    const inputTokens = Number(usage?.input_tokens ?? 0);
    const outputTokens = Number(usage?.output_tokens ?? 0);
    const totalTokens = Number(usage?.total_tokens ?? inputTokens + outputTokens);
    const content = [];
    if (extracted.reasoning) content.push({ type: "thinking" as const, thinking: extracted.reasoning });
    if (extracted.text || extracted.toolCalls.length === 0) content.push({ type: "text" as const, text: extracted.text || "" });

    return {
      sourceProtocol: "responses",
      id: typeof body.id === "string" ? body.id : `resp_${crypto.randomUUID().replace(/-/g, "")}`,
      model: typeof body.model === "string" ? body.model : null,
      created: createdToUnix(body.created_at ?? body.created),
      role: "assistant",
      content,
      tool_calls: extracted.toolCalls,
      stop_reason: extracted.toolCalls.length > 0 ? "tool_calls" : "stop",
      usage: normalizeUsage(inputTokens, outputTokens, totalTokens),
      extra: omitKeys(body, RESPONSE_KEYS),
    };
  },

  responseFromIntermediate(response) {
    const reasoningText = response.content
      .flatMap((part) => part.type === "thinking" && !part.redacted ? [part.thinking] : [])
      .join("");
    const textContent = response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");

    return {
      ...response.extra,
      id: response.id,
      object: "response",
      created_at: response.created,
      status: "completed",
      error: null,
      incomplete_details: null,
      model: response.model,
      output: [
        ...(reasoningText ? [{
          id: `rs_${crypto.randomUUID().replace(/-/g, "")}`,
          type: "reasoning",
          summary: [],
          content: [{ type: "reasoning_text", text: reasoningText }],
        }] : []),
        ...(textContent || response.tool_calls.length === 0 ? [{
          id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: textContent ? [{ type: "output_text", text: textContent, annotations: [] }] : [],
        }] : []),
        ...response.tool_calls.map((toolCall) => ({
          type: "function_call",
          id: toolCall.id ?? `fc_${crypto.randomUUID().replace(/-/g, "")}`,
          call_id: toolCall.id ?? `call_${crypto.randomUUID().replace(/-/g, "")}`,
          name: toolCall.name,
          arguments: toolCall.arguments,
          status: "completed",
        })),
      ],
      output_text: textContent,
      usage: response.usage ? {
        input_tokens: response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens,
      } : undefined,
    };
  },
};

export const responsesGatewayAdapter = createBodyProtocolGatewayAdapter({
  protocol: "responses",
  bodyAdapter: responsesAdapter,
  getInputText(body) {
    return inputTextFromMessages(
      normalizeResponsesInput(body.input, typeof body.instructions === "string" ? body.instructions : undefined),
    );
  },
  getMaxOutputTokens(body) {
    return body.max_output_tokens;
  },
});

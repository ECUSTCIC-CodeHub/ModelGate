import {
  extractThinkingText,
  normalizeResponsesInput,
  normalizedPartsToResponseContent,
  type JsonRecord,
} from "@/lib/gateway/normalized-message";

export function normalizeResponsesContextManagement(value: unknown) {
  if (value === undefined) return undefined;

  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (typeof item === "string") {
      return { type: item };
    }

    if (typeof item === "object" && item !== null) {
      const record = item as JsonRecord;
      if (typeof record.type === "string") {
        return record;
      }
    }

    return { type: "auto" };
  });
}
import {
  omitKeys,
  type IntermediateRequest,
} from "@/lib/gateway/protocol-adapters/intermediate";
import {
  responsesToolChoiceToIntermediate,
  responsesToolsToIntermediate,
  toolChoiceFromIntermediateForResponses,
  toolsFromIntermediateForResponses,
} from "@/lib/gateway/protocol-adapters/tools";

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
  "context_management",
];

export function responsesRequestToIntermediate(body: JsonRecord, realModel: string): IntermediateRequest {
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
    context_management: body.context_management,
    extra: omitKeys(body, REQUEST_KEYS),
  };
}

export function responsesRequestFromIntermediate(request: IntermediateRequest): JsonRecord {
  const extra = omitKeys(request.extra, ["context_management"]);
  const next: JsonRecord = {
    ...extra,
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
  if (request.metadata !== undefined) { next.metadata = request.metadata; next.store = true; }
  if (request.text !== undefined) next.text = request.text;
  if (request.context_management !== undefined) {
    next.context_management = normalizeResponsesContextManagement(request.context_management);
  }

  return next;
}

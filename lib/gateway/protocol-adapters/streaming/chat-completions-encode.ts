import type { JsonRecord } from "@/lib/gateway/normalized-message";
import type { ResponseAdapterOptions } from "@/lib/gateway/protocol-adapters/intermediate";
import {
  toSseBlock,
  type IntermediateStreamEvent,
  type StreamUsage,
} from "@/lib/gateway/protocol-adapters/streaming/common";

export function encodeChatCompletionsStream(events: ReadableStream<IntermediateStreamEvent>, options?: ResponseAdapterOptions) {
  const reader = events.getReader();
  const encoder = new TextEncoder();
  let id = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
  let model: string | null | undefined = null;
  let created = Math.floor(Date.now() / 1000);
  let usage: StreamUsage | null = null;
  let roleEmitted = false;
  let finished = false;
  const toolCalls = new Map<number, { id: string; name: string }>();

  const chatUsage = () => {
    if (!usage) return undefined;
    const completionDetails =
      usage.reasoning_tokens !== undefined || usage.text_tokens !== undefined
        ? {
            ...(usage.reasoning_tokens !== undefined ? { reasoning_tokens: usage.reasoning_tokens } : {}),
            ...(usage.text_tokens !== undefined ? { text_tokens: usage.text_tokens } : {}),
          }
        : undefined;
    const promptDetails =
      usage.cache_read_tokens !== undefined || usage.cache_creation_tokens !== undefined
        ? {
            ...(usage.cache_read_tokens !== undefined ? { cached_tokens: usage.cache_read_tokens } : {}),
            ...(usage.cache_creation_tokens !== undefined
              ? {
                  cache_creation: {
                    cache_creation_input_tokens: usage.cache_creation_tokens,
                    cache_type: "ephemeral",
                  },
                }
              : {}),
          }
        : undefined;
    return {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      ...(completionDetails ? { completion_tokens_details: completionDetails } : {}),
      ...(promptDetails ? { prompt_tokens_details: promptDetails } : {}),
    };
  };

  const emit = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    delta: JsonRecord,
    reason: string | null = null,
  ) => {
    controller.enqueue(encoder.encode(toSseBlock(null, {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{
        index: 0,
        delta,
        finish_reason: reason,
      }],
      ...(usage ? { usage: chatUsage() } : {}),
    })));
  };

  const emitRole = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (roleEmitted) return;
    emit(controller, { role: "assistant" });
    roleEmitted = true;
  };

  const emitDone = (controller: ReadableStreamDefaultController<Uint8Array>, reason: string | null) => {
    if (finished) return;
    finished = true;
    const finishReason = reason === "tool_use" ? "tool_calls" : reason ?? "stop";
    emit(controller, {}, finishReason);
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value.type === "start") {
            if (value.id) id = value.id;
            model = options?.requestedModel ?? value.model;
            if (value.created) created = value.created;
            if (value.usage) usage = value.usage;
            emitRole(controller);
            continue;
          }

          if (value.type === "usage") {
            usage = value.usage;
            continue;
          }

          if (value.type === "text_delta") {
            emitRole(controller);
            emit(controller, { content: value.text });
            continue;
          }

          if (value.type === "reasoning_delta") {
            emitRole(controller);
            emit(controller, { reasoning: value.text });
            continue;
          }

          if (value.type === "reasoning_signature") {
            continue;
          }

          if (value.type === "tool_call_start") {
            emitRole(controller);
            toolCalls.set(value.index, { id: value.id, name: value.name });
            emit(controller, {
              tool_calls: [{
                index: value.index,
                id: value.id,
                type: "function",
                function: {
                  name: value.name,
                  arguments: value.arguments ?? "",
                },
              }],
            });
            continue;
          }

          if (value.type === "tool_call_delta") {
            emitRole(controller);
            const toolCall = toolCalls.get(value.index);
            emit(controller, {
              tool_calls: [{
                index: value.index,
                id: value.id ?? toolCall?.id ?? `call_${crypto.randomUUID().replace(/-/g, "")}`,
                type: "function",
                function: {
                  name: value.name ?? toolCall?.name ?? "",
                  arguments: value.arguments,
                },
              }],
            });
            continue;
          }

          if (value.type === "finish") {
            emitDone(controller, value.reason);
          }
        }

        emitDone(controller, "stop");
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

import { asRecord, type JsonRecord } from "@/lib/gateway/normalized-message";
import { createChatToAnthropicStream } from "@/lib/gateway/protocol-adapters/streaming/chat-completions";
import { toSseBlock, type StreamTransformResult, type ToolCallState } from "@/lib/gateway/protocol-adapters/streaming/common";

type ResponsesSseEvent = {
  event: string;
  data: JsonRecord | string;
};

export function parseResponsesSseEvent(event: string, data: string): ResponsesSseEvent {
  try {
    const parsed = JSON.parse(data) as JsonRecord;
    const actualEvent = event || (typeof parsed.type === "string" ? parsed.type : "message");
    return { event: actualEvent, data: parsed };
  } catch {
    return { event: event || "message", data };
  }
}

export function trackResponsesStreamEvent(eventName: string, data: string) {
  const parsed = parseResponsesSseEvent(eventName, data);
  const payload = asRecord(parsed.data);
  if (parsed.event === "response.output_text.delta" && typeof payload?.delta === "string") {
    return { completionText: payload.delta };
  }
  if (parsed.event === "response.reasoning_text.delta" && typeof payload?.delta === "string") {
    return { completionText: payload.delta };
  }
  return null;
}

export function createResponsesToAnthropicStream(upstream: ReadableStream<Uint8Array>, thinkingEnabled = false): StreamTransformResult {
  const chat = createResponsesToChatStream(upstream);
  return createChatToAnthropicStream(chat.stream, thinkingEnabled);
}

export function createResponsesToChatStream(upstream: ReadableStream<Uint8Array>): StreamTransformResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let completionText = "";
  let reasoningText = "";
  let firstTokenAt: number | null = null;
  const markFirstToken = () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  };
  let responseId = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
  let model: string | null = null;
  let created = Math.floor(Date.now() / 1000);
  let finished = false;
  let finishReason = "stop";
  const toolCalls = new Map<string, ToolCallState>();
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

  const emitChatChunk = (controller: ReadableStreamDefaultController<Uint8Array>, delta: JsonRecord, reason: string | null = null) => {
    controller.enqueue(encoder.encode(toSseBlock(null, {
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: reason,
        },
      ],
      ...(usage ? { usage } : {}),
    })));
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          while (true) {
            const idx = buffer.indexOf("\n\n");
            if (idx === -1) break;
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            let eventName = "";
            const dataLines: string[] = [];
            for (const line of rawEvent.split("\n")) {
              if (line.startsWith("event:")) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trimStart());
              }
            }

            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n");
            if (data === "[DONE]") continue;

            const event = parseResponsesSseEvent(eventName, data);
            const payload = asRecord(event.data);
            const response = asRecord(payload?.response);

            if (response) {
              if (typeof response.id === "string") responseId = response.id;
              if (typeof response.model === "string") model = response.model;
              const createdRaw = response.created_at ?? response.created;
              const nextCreated = typeof createdRaw === "string"
                ? Math.floor(new Date(createdRaw).getTime() / 1000)
                : Number(createdRaw);
              if (Number.isFinite(nextCreated)) created = nextCreated;
            }

            if (event.event === "response.output_text.delta" && typeof payload?.delta === "string") {
              markFirstToken();
              completionText += payload.delta;
              emitChatChunk(controller, { content: payload.delta });
              continue;
            }

            if (event.event === "response.reasoning_text.delta" && typeof payload?.delta === "string") {
              markFirstToken();
              reasoningText += payload.delta;
              emitChatChunk(controller, { reasoning: payload.delta });
              continue;
            }

            if (event.event === "response.output_item.added") {
              const item = asRecord(payload?.item);
              if (item?.type === "function_call") {
                finishReason = "tool_calls";
                const callId = typeof item.call_id === "string"
                  ? item.call_id
                  : typeof item.id === "string"
                    ? item.id
                    : `call_${crypto.randomUUID().replace(/-/g, "")}`;
                const callState: ToolCallState = {
                  index: Number(payload?.output_index ?? toolCalls.size),
                  id: callId,
                  name: typeof item.name === "string" ? item.name : "",
                  arguments: typeof item.arguments === "string" ? item.arguments : "",
                };
                toolCalls.set(callId, callState);
                if (typeof item.id === "string") toolCalls.set(item.id, callState);
                emitChatChunk(controller, {
                  tool_calls: [{
                    index: callState.index,
                    id: callState.id,
                    type: "function",
                    function: {
                      name: callState.name,
                      arguments: callState.arguments,
                    },
                  }],
                });
              }
              continue;
            }

            if (event.event === "response.function_call_arguments.delta" && typeof payload?.delta === "string") {
              const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
              const existing = toolCalls.get(itemId);
              if (existing) {
                existing.arguments += payload.delta;
                emitChatChunk(controller, {
                  tool_calls: [{
                    index: existing.index,
                    id: existing.id,
                    type: "function",
                    function: {
                      name: existing.name,
                      arguments: payload.delta,
                    },
                  }],
                });
              }
              continue;
            }

            if (event.event === "response.function_call_arguments.done" && typeof payload?.arguments === "string") {
              const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
              const existing = toolCalls.get(itemId);
              if (existing) {
                const delta = payload.arguments.startsWith(existing.arguments)
                  ? payload.arguments.slice(existing.arguments.length)
                  : payload.arguments;
                existing.arguments = payload.arguments;
                if (delta) {
                  emitChatChunk(controller, {
                    tool_calls: [{
                      index: existing.index,
                      id: existing.id,
                      type: "function",
                      function: {
                        name: existing.name,
                        arguments: delta,
                      },
                    }],
                  });
                }
              }
              continue;
            }

            if (event.event === "response.completed") {
              const completedUsage = asRecord(response?.usage);
              usage = completedUsage
                ? {
                    prompt_tokens: Number(completedUsage.input_tokens ?? 0),
                    completion_tokens: Number(completedUsage.output_tokens ?? 0),
                    total_tokens: Number(completedUsage.total_tokens ?? 0),
                  }
                : usage;
              if (!finished) {
                finished = true;
                emitChatChunk(controller, {}, finishReason);
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              }
            }
          }
        }

        if (!finished) {
          emitChatChunk(controller, {}, finishReason);
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return {
    stream,
    completionText: () => `${reasoningText}${completionText}`,
    firstTokenAt: () => firstTokenAt,
  };
}

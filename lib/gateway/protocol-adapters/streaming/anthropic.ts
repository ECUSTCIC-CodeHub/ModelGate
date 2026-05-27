import { asRecord, type JsonRecord } from "@/lib/gateway/normalized-message";
import { createChatToResponsesStream } from "@/lib/gateway/protocol-adapters/streaming/chat-completions";
import { toSseBlock, type StreamTransformResult } from "@/lib/gateway/protocol-adapters/streaming/common";

type AnthropicSseEvent = {
  event: string;
  data: JsonRecord | string;
};

export function parseAnthropicSseEvent(event: string, data: string): AnthropicSseEvent {
  try {
    return { event, data: JSON.parse(data) as JsonRecord };
  } catch {
    return { event, data };
  }
}

export function trackAnthropicMessagesStreamEvent(eventName: string, data: string) {
  const parsed = parseAnthropicSseEvent(eventName, data);
  const payload = asRecord(parsed.data);
  if (parsed.event !== "content_block_delta") return null;
  const delta = asRecord(payload?.delta);
  if (delta?.type === "text_delta" && typeof delta.text === "string") {
    return { completionText: delta.text };
  }
  if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
    return { firstToken: true };
  }
  return null;
}

export function createAnthropicToChatStream(upstream: ReadableStream<Uint8Array>): StreamTransformResult {
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
  let id = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
  let model: string | null = null;
  const created = Math.floor(Date.now() / 1000);
  let roleEmitted = false;
  let finished = false;
  let finishReason: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  const toolUseByIndex = new Map<number, { id: string; name: string }>();
  const thinkingByIndex = new Map<number, { signature?: string }>();

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, delta: JsonRecord, reason: string | null = null) => {
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
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
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
            const lines = rawEvent.split("\n");
            let eventName = "";
            const dataLines: string[] = [];
            for (const line of lines) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
            }
            if (dataLines.length === 0) continue;
            const event = parseAnthropicSseEvent(eventName, dataLines.join("\n"));
            const payload = asRecord(event.data);

            if (event.event === "message_start") {
              const message = asRecord(payload?.message);
              if (typeof message?.id === "string") id = message.id;
              if (typeof message?.model === "string") model = message.model;
              const usage = asRecord(message?.usage);
              promptTokens = Number(usage?.input_tokens ?? 0);
              if (!roleEmitted) {
                emit(controller, { role: "assistant" });
                roleEmitted = true;
              }
              continue;
            }

            if (event.event === "content_block_start") {
              const block = asRecord(payload?.content_block);
              const indexNum = Number(payload?.index ?? 0);
              if (block?.type === "thinking" || block?.type === "redacted_thinking") {
                thinkingByIndex.set(indexNum, {});
              }
              if (block?.type === "tool_use") {
                const toolId = typeof block.id === "string" ? block.id : `toolu_${crypto.randomUUID().replace(/-/g, "")}`;
                const toolName = typeof block.name === "string" ? block.name : "";
                toolUseByIndex.set(indexNum, { id: toolId, name: toolName });
                emit(controller, {
                  tool_calls: [{
                    index: indexNum,
                    id: toolId,
                    type: "function",
                    function: {
                      name: toolName,
                      arguments: "",
                    },
                  }],
                });
              }
              continue;
            }

            if (event.event === "content_block_delta") {
              const delta = asRecord(payload?.delta);
              const indexNum = Number(payload?.index ?? 0);
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                markFirstToken();
                completionText += delta.text;
                emit(controller, { content: delta.text });
              } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
                markFirstToken();
                reasoningText += delta.thinking;
                emit(controller, { reasoning: delta.thinking });
              } else if (delta?.type === "signature_delta" && typeof delta.signature === "string") {
                const thinking = thinkingByIndex.get(indexNum) ?? {};
                thinking.signature = delta.signature;
                thinkingByIndex.set(indexNum, thinking);
              } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                const tool = toolUseByIndex.get(indexNum);
                if (tool) {
                  emit(controller, {
                    tool_calls: [{
                      index: indexNum,
                      id: tool.id,
                      type: "function",
                      function: {
                        name: tool.name,
                        arguments: delta.partial_json,
                      },
                    }],
                  });
                }
              }
              continue;
            }

            if (event.event === "message_delta") {
              const delta = asRecord(payload?.delta);
              finishReason = typeof delta?.stop_reason === "string"
                ? (delta.stop_reason === "tool_use" ? "tool_calls" : "stop")
                : finishReason;
              const usage = asRecord(payload?.usage);
              completionTokens = Number(usage?.output_tokens ?? completionTokens);
              continue;
            }

            if (event.event === "message_stop" && !finished) {
              finished = true;
              emit(controller, {}, finishReason ?? "stop");
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            }
          }
        }
        if (!finished) {
          emit(controller, {}, finishReason ?? "stop");
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return { stream, completionText: () => `${reasoningText}${completionText}`, firstTokenAt: () => firstTokenAt };
}

export function createAnthropicToResponsesStream(upstream: ReadableStream<Uint8Array>): StreamTransformResult {
  const chat = createAnthropicToChatStream(upstream);
  return createChatToResponsesStream(chat.stream);
}

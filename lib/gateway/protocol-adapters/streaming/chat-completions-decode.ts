import type {
  IntermediateStreamEvent,
  IntermediateStreamResult,
} from "@/lib/gateway/protocol-adapters/streaming/common";
import { parseChatChunkEvent } from "@/lib/gateway/protocol-adapters/streaming/chat-completions-events";

export function decodeChatCompletionsStream(upstream: ReadableStream<Uint8Array>): IntermediateStreamResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completionText = "";
  let reasoningText = "";
  let firstTokenAt: number | null = null;
  let started = false;
  const toolCalls = new Map<number, { id: string; name: string }>();
  const markFirstToken = () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  };

  const stream = new ReadableStream<IntermediateStreamEvent>({
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
            const dataLines = rawEvent
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart());
            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n");
            if (data === "[DONE]") continue;

            const parsed = parseChatChunkEvent(data);
            if (!started) {
              started = true;
              controller.enqueue({ type: "start", id: parsed.id, model: parsed.model, created: parsed.created });
            }

            if (parsed.usage) {
              controller.enqueue({ type: "usage", usage: parsed.usage });
            }

            if (parsed.reasoning) {
              markFirstToken();
              reasoningText += parsed.reasoning;
              controller.enqueue({ type: "reasoning_delta", text: parsed.reasoning });
            }

            if (parsed.content) {
              markFirstToken();
              completionText += parsed.content;
              controller.enqueue({ type: "text_delta", text: parsed.content });
            }

            for (const toolCall of parsed.toolCalls) {
              const existing = toolCalls.get(toolCall.index);
              if (!existing) {
                const id = toolCall.id || `call_${crypto.randomUUID().replace(/-/g, "")}`;
                toolCalls.set(toolCall.index, { id, name: toolCall.name });
                controller.enqueue({
                  type: "tool_call_start",
                  index: toolCall.index,
                  id,
                  name: toolCall.name,
                });
              } else if (toolCall.name) {
                existing.name = toolCall.name;
              }

              if (toolCall.arguments) {
                controller.enqueue({
                  type: "tool_call_delta",
                  index: toolCall.index,
                  id: toolCalls.get(toolCall.index)?.id,
                  name: toolCall.name || toolCalls.get(toolCall.index)?.name,
                  arguments: toolCall.arguments,
                });
              }
            }

            if (parsed.finishReason) {
              controller.enqueue({ type: "finish", reason: parsed.finishReason });
            }
          }
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

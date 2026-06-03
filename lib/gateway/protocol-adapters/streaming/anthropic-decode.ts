import { asRecord } from "@/lib/gateway/normalized-message";
import {
  type IntermediateStreamEvent,
  type IntermediateStreamResult,
  type StreamUsage,
} from "@/lib/gateway/protocol-adapters/streaming/common";
import { parseAnthropicSseEvent } from "@/lib/gateway/protocol-adapters/streaming/anthropic-events";
import { usageFromAnthropic } from "@/lib/gateway/protocol-adapters/usage";

export function decodeAnthropicMessagesStream(upstream: ReadableStream<Uint8Array>): IntermediateStreamResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completionText = "";
  let reasoningText = "";
  let firstTokenAt: number | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  let cacheMissTokens: number | undefined;
  let hasUsage = false;
  let finishReason: string | null = null;
  const toolUseByIndex = new Map<number, { id: string; name: string }>();
  const markFirstToken = () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  };

  const usage = (): StreamUsage => ({
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...(cacheReadTokens !== undefined ? { cache_read_tokens: cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cache_creation_tokens: cacheCreationTokens } : {}),
    ...(cacheMissTokens !== undefined ? { cache_miss_tokens: cacheMissTokens } : {}),
  });

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
              const nextUsage = usageFromAnthropic(message?.usage);
              promptTokens = nextUsage?.prompt_tokens ?? 0;
              cacheReadTokens = nextUsage?.cache_read_tokens;
              cacheCreationTokens = nextUsage?.cache_creation_tokens;
              cacheMissTokens = nextUsage?.cache_miss_tokens;
              hasUsage = hasUsage || Boolean(nextUsage);
              controller.enqueue({
                type: "start",
                id: typeof message?.id === "string" ? message.id : undefined,
                model: typeof message?.model === "string" ? message.model : null,
                usage: usage(),
              });
              continue;
            }

            if (event.event === "content_block_start") {
              const block = asRecord(payload?.content_block);
              const index = Number(payload?.index ?? 0);
              if (block?.type === "tool_use") {
                const id = typeof block.id === "string" ? block.id : `toolu_${crypto.randomUUID().replace(/-/g, "")}`;
                const name = typeof block.name === "string" ? block.name : "";
                toolUseByIndex.set(index, { id, name });
                controller.enqueue({ type: "tool_call_start", index, id, name });
              }
              continue;
            }

            if (event.event === "content_block_delta") {
              const delta = asRecord(payload?.delta);
              const index = Number(payload?.index ?? 0);
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                markFirstToken();
                completionText += delta.text;
                controller.enqueue({ type: "text_delta", text: delta.text });
              } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
                markFirstToken();
                reasoningText += delta.thinking;
                controller.enqueue({ type: "reasoning_delta", text: delta.thinking });
              } else if (delta?.type === "signature_delta" && typeof delta.signature === "string") {
                controller.enqueue({ type: "reasoning_signature", signature: delta.signature });
              } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                const tool = toolUseByIndex.get(index);
                controller.enqueue({
                  type: "tool_call_delta",
                  index,
                  id: tool?.id,
                  name: tool?.name,
                  arguments: delta.partial_json,
                });
              }
              continue;
            }

            if (event.event === "message_delta") {
              const delta = asRecord(payload?.delta);
              finishReason = typeof delta?.stop_reason === "string"
                ? (delta.stop_reason === "tool_use" ? "tool_calls" : "stop")
                : finishReason;
              const nextUsage = usageFromAnthropic(payload?.usage);
              completionTokens = nextUsage?.completion_tokens ?? completionTokens;
              cacheReadTokens = nextUsage?.cache_read_tokens ?? cacheReadTokens;
              cacheCreationTokens = nextUsage?.cache_creation_tokens ?? cacheCreationTokens;
              cacheMissTokens = nextUsage?.cache_miss_tokens ?? cacheMissTokens;
              hasUsage = hasUsage || Boolean(nextUsage);
              controller.enqueue({ type: "usage", usage: usage() });
              continue;
            }

            if (event.event === "message_stop") {
              controller.enqueue({ type: "finish", reason: finishReason ?? "stop" });
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
    completionText: () => completionText,
    reasoningText: () => reasoningText,
    firstTokenAt: () => firstTokenAt,
    usage: () => (hasUsage ? usage() : null),
  };
}

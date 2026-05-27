import { asArray, asRecord, type JsonRecord } from "@/lib/gateway/normalized-message";
import {
  toSseBlock,
  type IntermediateStreamEvent,
  type IntermediateStreamResult,
  type StreamUsage,
} from "@/lib/gateway/protocol-adapters/streaming/common";

type ChatToolDelta = {
  index: number;
  id: string;
  name: string;
  arguments: string;
};

export function parseChatChunkEvent(data: string) {
  const parsed = JSON.parse(data) as JsonRecord;
  const choices = asArray(parsed.choices);
  const firstChoice = asRecord(choices[0]);
  const delta = asRecord(firstChoice?.delta);
  const toolCalls = asArray(delta?.tool_calls)
    .map((item) => {
      const record = asRecord(item);
      const fn = asRecord(record?.function);
      if (!record) return null;
      return {
        index: Number(record.index ?? 0),
        id: typeof record.id === "string" ? record.id : "",
        name: typeof fn?.name === "string" ? fn.name : "",
        arguments: typeof fn?.arguments === "string" ? fn.arguments : "",
      };
    })
    .filter((item): item is ChatToolDelta => Boolean(item));

  const usage = asRecord(parsed.usage);
  return {
    id: typeof parsed.id === "string" ? parsed.id : `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    model: typeof parsed.model === "string" ? parsed.model : null,
    created: Number(parsed.created ?? Math.floor(Date.now() / 1000)),
    content: typeof delta?.content === "string" ? delta.content : "",
    reasoning: typeof delta?.reasoning === "string"
      ? delta.reasoning
      : typeof delta?.reasoning_content === "string"
        ? delta.reasoning_content
        : "",
    toolCalls,
    finishReason: typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : null,
    usage: usage
      ? {
          prompt_tokens: Number(usage.prompt_tokens ?? 0),
          completion_tokens: Number(usage.completion_tokens ?? 0),
          total_tokens: Number(usage.total_tokens ?? 0),
        }
      : null,
  };
}

export function trackChatCompletionsStreamEvent(_event: string, data: string) {
  const parsed = parseChatChunkEvent(data);
  if (parsed.content) return { completionText: parsed.content };
  if (parsed.reasoning) return { firstToken: true };
  return null;
}

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

export function encodeChatCompletionsStream(events: ReadableStream<IntermediateStreamEvent>) {
  const reader = events.getReader();
  const encoder = new TextEncoder();
  let id = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
  let model: string | null = null;
  let created = Math.floor(Date.now() / 1000);
  let usage: StreamUsage | null = null;
  let roleEmitted = false;
  let finished = false;
  const toolCalls = new Map<number, { id: string; name: string }>();

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
      ...(usage ? { usage } : {}),
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
            if (value.model !== undefined) model = value.model;
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

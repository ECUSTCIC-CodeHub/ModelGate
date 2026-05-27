import type { GatewayProtocol } from "@/lib/gateway/protocols";
import { asArray, asRecord, type JsonRecord } from "@/lib/gateway/normalized-message";
import type { ResponseAdapterOptions } from "@/lib/gateway/protocol-adapters/intermediate";
import type { GatewayProtocolAdapter } from "@/lib/gateway/protocol-adapters/runtime";

type ToolCallState = {
  index: number;
  id: string;
  name: string;
  arguments: string;
};

function parseChatChunkEvent(data: string) {
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
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

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

type ResponsesSseEvent = {
  event: string;
  data: JsonRecord | string;
};

function parseResponsesSseEvent(event: string, data: string): ResponsesSseEvent {
  try {
    const parsed = JSON.parse(data) as JsonRecord;
    const actualEvent = event || (typeof parsed.type === "string" ? parsed.type : "message");
    return { event: actualEvent, data: parsed };
  } catch {
    return { event: event || "message", data };
  }
}

type AnthropicSseEvent = {
  event: string;
  data: JsonRecord | string;
};

function parseAnthropicSseEvent(event: string, data: string): AnthropicSseEvent {
  try {
    return { event, data: JSON.parse(data) as JsonRecord };
  } catch {
    return { event, data };
  }
}

function toSseBlock(event: string | null, data: unknown) {
  const lines: string[] = [];
  if (event) lines.push(`event: ${event}`);
  const json = typeof data === "string" ? data : JSON.stringify(data);
  for (const line of json.split("\n")) {
    lines.push(`data: ${line}`);
  }
  return `${lines.join("\n")}\n\n`;
}

type StreamTransformResult = {
  stream: ReadableStream<Uint8Array>;
  completionText: () => string;
  firstTokenAt: () => number | null;
};

export function createTransformedStream(
  upstream: ReadableStream<Uint8Array>,
  outboundAdapter: GatewayProtocolAdapter,
  inboundAdapter: GatewayProtocolAdapter,
  options?: ResponseAdapterOptions,
) : StreamTransformResult {
  const outboundProtocol = outboundAdapter.protocol;
  const inboundProtocol = inboundAdapter.protocol;
  if (outboundProtocol === inboundProtocol) {
    return createPassthroughStream(upstream, outboundProtocol);
  }

  const thinkingEnabled = options?.thinkingEnabled ?? false;

  return outboundProtocol === "chat_completions"
    ? inboundProtocol === "responses"
      ? createChatToResponsesStream(upstream)
      : createChatToAnthropicStream(upstream, thinkingEnabled)
    : outboundProtocol === "responses"
      ? inboundProtocol === "chat_completions"
        ? createResponsesToChatStream(upstream)
        : createResponsesToAnthropicStream(upstream, thinkingEnabled)
      : inboundProtocol === "chat_completions"
        ? createAnthropicToChatStream(upstream)
        : createAnthropicToResponsesStream(upstream);
}

function createPassthroughStream(upstream: ReadableStream<Uint8Array>, protocol: GatewayProtocol): StreamTransformResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let completionText = "";
  let buffer = "";
  let firstTokenAt: number | null = null;
  const markFirstToken = () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          controller.enqueue(value);
          const decoded = decoder.decode(value, { stream: true });
          buffer += decoded.replace(/\r\n/g, "\n");

          while (true) {
            const idx = buffer.indexOf("\n\n");
            if (idx === -1) break;
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let eventName = "";
            const dataLines: string[] = [];
            for (const line of rawEvent.split("\n")) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
            }
            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n");
            if (data === "[DONE]") continue;

            try {
              if (protocol === "chat_completions") {
                const event = parseChatChunkEvent(data);
                if (event.content) {
                  markFirstToken();
                  completionText += event.content;
                } else if (event.reasoning) {
                  markFirstToken();
                }
              } else if (protocol === "anthropic_messages") {
                const parsed = parseAnthropicSseEvent(eventName, data);
                const payload = asRecord(parsed.data);
                if (parsed.event === "content_block_delta") {
                  const delta = asRecord(payload?.delta);
                  if (delta?.type === "text_delta" && typeof delta.text === "string") {
                    markFirstToken();
                    completionText += delta.text;
                  } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
                    markFirstToken();
                  }
                }
              } else {
                const parsed = parseResponsesSseEvent(eventName, data);
                if (parsed.event === "response.output_text.delta" && typeof (parsed.data as JsonRecord).delta === "string") {
                  markFirstToken();
                  completionText += (parsed.data as JsonRecord).delta as string;
                } else if (parsed.event === "response.reasoning_text.delta" && typeof (parsed.data as JsonRecord).delta === "string") {
                  markFirstToken();
                  completionText += (parsed.data as JsonRecord).delta as string;
                }
              }
            } catch {
              // Ignore malformed event for metrics capture only.
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
    firstTokenAt: () => firstTokenAt,
  };
}

function createAnthropicToChatStream(upstream: ReadableStream<Uint8Array>): StreamTransformResult {
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

function createAnthropicToResponsesStream(upstream: ReadableStream<Uint8Array>): StreamTransformResult {
  const chat = createAnthropicToChatStream(upstream);
  return createChatToResponsesStream(chat.stream);
}

function createChatToAnthropicStream(upstream: ReadableStream<Uint8Array>, thinkingEnabled = false): StreamTransformResult {
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
  let started = false;
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  let thinkingStarted = false;
  let model: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, event: string, payload: unknown) => {
    controller.enqueue(encoder.encode(toSseBlock(event, payload)));
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
            const dataLines = rawEvent.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n");
            if (data === "[DONE]") continue;
            const parsed = parseChatChunkEvent(data);
            model = parsed.model;
            if (parsed.usage) {
              promptTokens = parsed.usage.prompt_tokens;
              completionTokens = parsed.usage.completion_tokens;
            }
            if (!started) {
              started = true;
              emit(controller, "message_start", {
                type: "message_start",
                message: {
                  id: messageId,
                  type: "message",
                  role: "assistant",
                  model,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: {
                    input_tokens: promptTokens,
                    output_tokens: 0,
                  },
                },
              });
            }

            if (parsed.reasoning) {
              markFirstToken();
              reasoningText += parsed.reasoning;
              if (thinkingEnabled) {
                if (!thinkingStarted) {
                  thinkingStarted = true;
                  emit(controller, "content_block_start", {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "thinking", thinking: "" },
                  });
                }
                emit(controller, "content_block_delta", {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "thinking_delta", thinking: parsed.reasoning },
                });
              }
            }

            if (parsed.content) {
              markFirstToken();
              if (completionText.length === 0) {
                emit(controller, "content_block_start", {
                  type: "content_block_start",
                  index: thinkingStarted ? 1 : 0,
                  content_block: { type: "text", text: "" },
                });
              }
              completionText += parsed.content;
              emit(controller, "content_block_delta", {
                type: "content_block_delta",
                index: thinkingStarted ? 1 : 0,
                delta: { type: "text_delta", text: parsed.content },
              });
            }

            for (const toolCall of parsed.toolCalls) {
              emit(controller, "content_block_start", {
                type: "content_block_start",
                index: toolCall.index + (thinkingStarted ? 2 : 1),
                content_block: {
                  type: "tool_use",
                  id: toolCall.id || `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
                  name: toolCall.name,
                  input: {},
                },
              });
              emit(controller, "content_block_delta", {
                type: "content_block_delta",
                index: toolCall.index + (thinkingStarted ? 2 : 1),
                delta: {
                  type: "input_json_delta",
                  partial_json: toolCall.arguments,
                },
              });
            }

            if (parsed.finishReason) {
              if (thinkingStarted) {
                emit(controller, "content_block_stop", { type: "content_block_stop", index: 0 });
              }
              if (completionText.length > 0) {
                emit(controller, "content_block_stop", { type: "content_block_stop", index: thinkingStarted ? 1 : 0 });
              }
              emit(controller, "message_delta", {
                type: "message_delta",
                delta: {
                  stop_reason: parsed.finishReason === "tool_calls" ? "tool_use" : "end_turn",
                  stop_sequence: null,
                },
                usage: {
                  output_tokens: completionTokens,
                },
              });
              emit(controller, "message_stop", { type: "message_stop" });
            }
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return { stream, completionText: () => `${reasoningText}${completionText}`, firstTokenAt: () => firstTokenAt };
}

function createResponsesToAnthropicStream(upstream: ReadableStream<Uint8Array>, thinkingEnabled = false): StreamTransformResult {
  const chat = createResponsesToChatStream(upstream);
  return createChatToAnthropicStream(chat.stream, thinkingEnabled);
}

function createChatToResponsesStream(upstream: ReadableStream<Uint8Array>): StreamTransformResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let completionText = "";
  let firstTokenAt: number | null = null;
  const markFirstToken = () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  };
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const outputMessageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  const reasoningItemId = `rs_${crypto.randomUUID().replace(/-/g, "")}`;
  const toolCalls = new Map<number, ToolCallState>();
  let started = false;
  let emittedDone = false;
  let reasoningStarted = false;
  let reasoningText = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;

  const emitStart = (controller: ReadableStreamDefaultController<Uint8Array>, model: string | null, created: number) => {
    if (started) return;
    started = true;
    controller.enqueue(encoder.encode(toSseBlock("response.created", {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        created_at: created,
        model,
        status: "in_progress",
        output: [],
      },
    })));
    controller.enqueue(encoder.encode(toSseBlock("response.in_progress", {
      type: "response.in_progress",
      response: {
        id: responseId,
        object: "response",
        created_at: created,
        model,
        status: "in_progress",
        output: [],
      },
    })));
  };

  const emitMessageStart = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.enqueue(encoder.encode(toSseBlock("response.output_item.added", {
      type: "response.output_item.added",
      response_id: responseId,
      output_index: 0,
      item: {
        id: outputMessageId,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    })));
    controller.enqueue(encoder.encode(toSseBlock("response.content_part.added", {
      type: "response.content_part.added",
      response_id: responseId,
      item_id: outputMessageId,
      output_index: 0,
      content_index: 0,
      part: {
        type: "output_text",
        text: "",
        annotations: [],
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

            const dataLines = rawEvent
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart());
            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n");
            if (data === "[DONE]") continue;

            const parsed = parseChatChunkEvent(data);
            emitStart(controller, parsed.model, parsed.created);

            if ((parsed.content || parsed.reasoning) && completionText.length === 0) {
              if (parsed.reasoning && !reasoningStarted) {
                reasoningStarted = true;
                controller.enqueue(encoder.encode(toSseBlock("response.output_item.added", {
                  type: "response.output_item.added",
                  response_id: responseId,
                  output_index: 0,
                  item: {
                    id: reasoningItemId,
                    type: "reasoning",
                    summary: [],
                    content: [],
                    status: "in_progress",
                  },
                })));
              }
              if (parsed.content) {
                emitMessageStart(controller);
              }
            }

            if (parsed.reasoning) {
              markFirstToken();
              reasoningText += parsed.reasoning;
              controller.enqueue(encoder.encode(toSseBlock("response.reasoning_text.delta", {
                type: "response.reasoning_text.delta",
                response_id: responseId,
                item_id: reasoningItemId,
                output_index: 0,
                content_index: 0,
                delta: parsed.reasoning,
              })));
            }

            if (parsed.content) {
              markFirstToken();
              if (completionText.length === 0) {
                emitMessageStart(controller);
              }
              completionText += parsed.content;
              controller.enqueue(encoder.encode(toSseBlock("response.output_text.delta", {
                type: "response.output_text.delta",
                response_id: responseId,
                item_id: outputMessageId,
                output_index: 0,
                content_index: 0,
                delta: parsed.content,
              })));
            }

            for (const toolCall of parsed.toolCalls) {
              const existing = toolCalls.get(toolCall.index);
              if (!existing) {
                const state: ToolCallState = {
                  index: toolCall.index,
                  id: toolCall.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
                  name: toolCall.name,
                  arguments: toolCall.arguments,
                };
                toolCalls.set(toolCall.index, state);
                controller.enqueue(encoder.encode(toSseBlock("response.output_item.added", {
                  type: "response.output_item.added",
                  response_id: responseId,
                  output_index: toolCall.index + 1,
                  item: {
                    type: "function_call",
                    id: state.id,
                    call_id: state.id,
                    name: state.name,
                    arguments: state.arguments,
                    status: "in_progress",
                  },
                })));
              } else {
                existing.arguments += toolCall.arguments;
                if (toolCall.name) existing.name = toolCall.name;
              }

              controller.enqueue(encoder.encode(toSseBlock("response.function_call_arguments.delta", {
                type: "response.function_call_arguments.delta",
                response_id: responseId,
                item_id: toolCalls.get(toolCall.index)?.id ?? "",
                output_index: toolCall.index + 1,
                delta: toolCall.arguments,
              })));
            }

            if (parsed.usage) {
              promptTokens = parsed.usage.prompt_tokens;
              completionTokens = parsed.usage.completion_tokens;
              totalTokens = parsed.usage.total_tokens;
            }

            if (parsed.finishReason && !emittedDone) {
              emittedDone = true;
              if (reasoningStarted) {
                controller.enqueue(encoder.encode(toSseBlock("response.reasoning_text.done", {
                  type: "response.reasoning_text.done",
                  response_id: responseId,
                  item_id: reasoningItemId,
                  output_index: 0,
                  content_index: 0,
                  text: reasoningText,
                })));
                controller.enqueue(encoder.encode(toSseBlock("response.output_item.done", {
                  type: "response.output_item.done",
                  response_id: responseId,
                  output_index: 0,
                  item: {
                    id: reasoningItemId,
                    type: "reasoning",
                    summary: [],
                    content: [{ type: "reasoning_text", text: reasoningText }],
                    status: "completed",
                  },
                })));
              }
              controller.enqueue(encoder.encode(toSseBlock("response.output_text.done", {
                type: "response.output_text.done",
                response_id: responseId,
                item_id: outputMessageId,
                output_index: 0,
                content_index: 0,
                text: completionText,
              })));
              controller.enqueue(encoder.encode(toSseBlock("response.completed", {
                type: "response.completed",
                response: {
                  id: responseId,
                  object: "response",
                  status: "completed",
                  output: (reasoningStarted || completionText)
                    ? [
                        ...(reasoningStarted ? [{
                          id: reasoningItemId,
                          type: "reasoning",
                          summary: [],
                          content: [{ type: "reasoning_text", text: reasoningText }],
                          status: "completed",
                        }] : []),
                        ...(completionText ? [{
                        id: outputMessageId,
                        type: "message",
                        role: "assistant",
                        status: "completed",
                        content: [{ type: "output_text", text: completionText, annotations: [] }],
                      }] : []),
                      ]
                    : [],
                  output_text: completionText,
                  usage: {
                    input_tokens: promptTokens,
                    output_tokens: completionTokens,
                    total_tokens: totalTokens,
                  },
                },
              })));
            }
          }
        }

        if (!emittedDone) {
          controller.enqueue(encoder.encode(toSseBlock("response.completed", {
            type: "response.completed",
            response: {
              id: responseId,
              object: "response",
              status: "completed",
              output: (reasoningStarted || completionText)
                ? [
                    ...(reasoningStarted ? [{
                      id: reasoningItemId,
                      type: "reasoning",
                      summary: [],
                      content: [{ type: "reasoning_text", text: reasoningText }],
                      status: "completed",
                    }] : []),
                    ...(completionText ? [{
                    id: outputMessageId,
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: completionText, annotations: [] }],
                  }] : []),
                  ]
                : [],
              output_text: completionText,
              usage: {
                input_tokens: promptTokens,
                output_tokens: completionTokens,
                total_tokens: totalTokens,
              },
            },
          })));
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

function createResponsesToChatStream(upstream: ReadableStream<Uint8Array>): StreamTransformResult {
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

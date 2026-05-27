import { asArray, asRecord, type JsonRecord } from "@/lib/gateway/normalized-message";
import { toSseBlock, type StreamTransformResult, type ToolCallState } from "@/lib/gateway/protocol-adapters/streaming/common";

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

export function trackChatCompletionsStreamEvent(_event: string, data: string) {
  const parsed = parseChatChunkEvent(data);
  if (parsed.content) return { completionText: parsed.content };
  if (parsed.reasoning) return { firstToken: true };
  return null;
}

export function createChatToAnthropicStream(upstream: ReadableStream<Uint8Array>, thinkingEnabled = false): StreamTransformResult {
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

export function createChatToResponsesStream(upstream: ReadableStream<Uint8Array>): StreamTransformResult {
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

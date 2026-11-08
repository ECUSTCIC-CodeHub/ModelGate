import { errorMessageFrom, toSseBlock, } from "@/lib/gateway/protocol-adapters/streaming/common";
import { createStreamUsageFallback } from "@/lib/gateway/protocol-adapters/streaming/usage-fallback";
export function encodeChatCompletionsStream(events, options) {
    const reader = events.getReader();
    const encoder = new TextEncoder();
    let id = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
    let model = null;
    let created = Math.floor(Date.now() / 1000);
    let usage = null;
    let roleEmitted = false;
    let finished = false;
    const toolCalls = new Map();
    const emittedToolCalls = new Set();
    const includeUsage = options?.includeUsage === true;
    const promptTokens = options?.streamPromptTokens ?? 0;
    // 客户端 SSE 的 usage 兜底与账务侧共用同一分词器与 real_model，不再用字符数/4 的启发式
    const meter = createStreamUsageFallback({ promptTokens, model: options?.streamUsageModel });
    const chatUsage = (u) => {
        const completionDetails = u.reasoning_tokens !== undefined
            ? { reasoning_tokens: u.reasoning_tokens }
            : undefined;
        const promptDetails = u.cache_read_tokens !== undefined || u.cache_creation_tokens !== undefined
            ? {
                ...(u.cache_read_tokens !== undefined ? { cached_tokens: u.cache_read_tokens } : {}),
                ...(u.cache_creation_tokens !== undefined
                    ? {
                        cache_creation: {
                            cache_creation_input_tokens: u.cache_creation_tokens,
                            cache_type: "ephemeral",
                        },
                    }
                    : {}),
            }
            : undefined;
        return {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
            ...(completionDetails ? { completion_tokens_details: completionDetails } : {}),
            ...(promptDetails ? { prompt_tokens_details: promptDetails } : {}),
        };
    };
    const emit = (controller, delta, reason = null) => {
        const chunkPayload = {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{
                    index: 0,
                    delta,
                    finish_reason: reason,
                }],
        };
        if (includeUsage) {
            chunkPayload.usage = null;
        }
        else if (usage) {
            chunkPayload.usage = chatUsage(usage);
        }
        controller.enqueue(encoder.encode(toSseBlock(null, chunkPayload)));
    };
    const emitRole = (controller) => {
        if (roleEmitted)
            return;
        emit(controller, { role: "assistant" });
        roleEmitted = true;
    };
    const emitDone = (controller, reason) => {
        if (finished)
            return;
        finished = true;
        const finishReason = reason === "tool_use" ? "tool_calls" : reason ?? "stop";
        emit(controller, {}, finishReason);
        if (includeUsage) {
            controller.enqueue(encoder.encode(toSseBlock(null, {
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [],
                usage: chatUsage(meter.complete(usage, model)),
            })));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    };
    return new ReadableStream({
        async start(controller) {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    if (value.type === "start") {
                        if (value.id)
                            id = value.id;
                        model = options?.requestedModel ?? value.model;
                        if (value.created)
                            created = value.created;
                        if (value.usage)
                            usage = value.usage;
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
                        meter.observeText(value.text);
                        continue;
                    }
                    if (value.type === "reasoning_delta") {
                        emitRole(controller);
                        emit(controller, { reasoning: value.text });
                        meter.observeReasoning(value.text);
                        continue;
                    }
                    if (value.type === "reasoning_signature") {
                        continue;
                    }
                    if (value.type === "tool_call_start") {
                        emitRole(controller);
                        toolCalls.set(value.index, { id: value.id, name: value.name });
                        meter.observeToolCall(value.name, value.arguments);
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
                        meter.observeToolArguments(value.arguments);
                        if (emittedToolCalls.has(value.index)) {
                            emit(controller, {
                                tool_calls: [{
                                        index: value.index,
                                        function: {
                                            arguments: value.arguments,
                                        },
                                    }],
                            });
                        }
                        else {
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
                            emittedToolCalls.add(value.index);
                        }
                        continue;
                    }
                    if (value.type === "finish") {
                        emitDone(controller, value.reason);
                    }
                }
                emitDone(controller, "stop");
                controller.close();
            }
            catch (error) {
                controller.enqueue(encoder.encode(toSseBlock(null, {
                    error: { message: errorMessageFrom(error), type: "upstream_error" },
                })));
                controller.close();
            }
        },
    });
}

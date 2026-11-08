import { finishReasonToAnthropic } from "@/lib/gateway/protocol-adapters/intermediate";
import { errorMessageFrom, toSseBlock, } from "@/lib/gateway/protocol-adapters/streaming/common";
import { createStreamUsageFallback } from "@/lib/gateway/protocol-adapters/streaming/usage-fallback";
export function encodeAnthropicMessagesStream(events, options) {
    const reader = events.getReader();
    const encoder = new TextEncoder();
    const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    let model = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let cacheReadTokens;
    let cacheCreationTokens;
    let started = false;
    let finished = false;
    let nextBlockIndex = 0;
    let thinkingIndex = null;
    let textIndex = null;
    const openBlocks = new Set();
    const toolBlockByIndex = new Map();
    const thinkingEnabled = options?.thinkingEnabled ?? false;
    // 部分上游不在 message_delta 回传 usage，直接透传会让客户端拿到 0；用与账务侧同一个分词器兜底
    const meter = createStreamUsageFallback({ promptTokens: options?.streamPromptTokens, model: options?.streamUsageModel });
    let remoteUsage = null;
    const emit = (controller, event, payload) => {
        controller.enqueue(encoder.encode(toSseBlock(event, payload)));
    };
    const ensureStarted = (controller) => {
        if (started)
            return;
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
                    // 上游没给 input_tokens 时才用本地分词估算，上游给了就以上游为准（与账务口径一致）
                    input_tokens: promptTokens > 0 ? promptTokens : meter.localPromptTokens,
                    output_tokens: 0,
                    cache_read_input_tokens: cacheReadTokens,
                    cache_creation_input_tokens: cacheCreationTokens,
                },
            },
        });
    };
    const startBlock = (controller, contentBlock) => {
        const index = nextBlockIndex;
        nextBlockIndex += 1;
        openBlocks.add(index);
        emit(controller, "content_block_start", {
            type: "content_block_start",
            index,
            content_block: contentBlock,
        });
        return index;
    };
    const stopOpenBlocks = (controller) => {
        for (const index of [...openBlocks].sort((a, b) => a - b)) {
            emit(controller, "content_block_stop", { type: "content_block_stop", index });
            openBlocks.delete(index);
        }
    };
    const emitDone = (controller, reason) => {
        if (finished)
            return;
        finished = true;
        stopOpenBlocks(controller);
        const finalUsage = meter.complete(remoteUsage ?? {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
        }, model);
        // 缓存字段可能只在 message_start 出现过，因此以累计变量为准
        const cacheRead = cacheReadTokens ?? finalUsage.cache_read_tokens;
        const cacheCreation = cacheCreationTokens ?? finalUsage.cache_creation_tokens;
        // Anthropic 客户端（CC Switch 等）靠 message_delta.usage 统计 Token 与输出速度，
        // 因此这里补全 input_tokens 与缓存字段，而不是只回输出侧
        emit(controller, "message_delta", {
            type: "message_delta",
            delta: {
                stop_reason: finishReasonToAnthropic(reason, false),
                stop_sequence: null,
            },
            usage: {
                input_tokens: finalUsage.prompt_tokens,
                output_tokens: finalUsage.completion_tokens,
                ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
                ...(cacheCreation !== undefined ? { cache_creation_input_tokens: cacheCreation } : {}),
            },
        });
        emit(controller, "message_stop", { type: "message_stop" });
    };
    return new ReadableStream({
        async start(controller) {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    if (value.type === "start") {
                        model = options?.requestedModel ?? value.model;
                        if (value.usage) {
                            promptTokens = value.usage.prompt_tokens;
                            completionTokens = value.usage.completion_tokens;
                            cacheReadTokens = value.usage.cache_read_tokens;
                            cacheCreationTokens = value.usage.cache_creation_tokens;
                        }
                        ensureStarted(controller);
                        continue;
                    }
                    if (value.type === "usage") {
                        remoteUsage = value.usage;
                        promptTokens = value.usage.prompt_tokens;
                        completionTokens = value.usage.completion_tokens;
                        cacheReadTokens = value.usage.cache_read_tokens;
                        cacheCreationTokens = value.usage.cache_creation_tokens;
                        continue;
                    }
                    if (value.type === "reasoning_delta") {
                        meter.observeReasoning(value.text);
                        ensureStarted(controller);
                        if (thinkingEnabled) {
                            if (thinkingIndex === null) {
                                thinkingIndex = startBlock(controller, { type: "thinking", thinking: "" });
                            }
                            emit(controller, "content_block_delta", {
                                type: "content_block_delta",
                                index: thinkingIndex,
                                delta: { type: "thinking_delta", thinking: value.text },
                            });
                        }
                        continue;
                    }
                    if (value.type === "reasoning_signature") {
                        ensureStarted(controller);
                        if (thinkingEnabled && thinkingIndex !== null) {
                            emit(controller, "content_block_delta", {
                                type: "content_block_delta",
                                index: thinkingIndex,
                                delta: { type: "signature_delta", signature: value.signature },
                            });
                        }
                        continue;
                    }
                    if (value.type === "text_delta") {
                        meter.observeText(value.text);
                        ensureStarted(controller);
                        if (textIndex === null) {
                            textIndex = startBlock(controller, { type: "text", text: "" });
                        }
                        emit(controller, "content_block_delta", {
                            type: "content_block_delta",
                            index: textIndex,
                            delta: { type: "text_delta", text: value.text },
                        });
                        continue;
                    }
                    if (value.type === "tool_call_start") {
                        ensureStarted(controller);
                        const index = startBlock(controller, {
                            type: "tool_use",
                            id: value.id || `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
                            name: value.name,
                            input: {},
                        });
                        toolBlockByIndex.set(value.index, index);
                        meter.observeToolCall(value.name, value.arguments);
                        if (value.arguments) {
                            emit(controller, "content_block_delta", {
                                type: "content_block_delta",
                                index,
                                delta: { type: "input_json_delta", partial_json: value.arguments },
                            });
                        }
                        continue;
                    }
                    if (value.type === "tool_call_delta") {
                        ensureStarted(controller);
                        const index = toolBlockByIndex.get(value.index)
                            ?? startBlock(controller, {
                                type: "tool_use",
                                id: value.id || `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
                                name: value.name ?? "",
                                input: {},
                            });
                        toolBlockByIndex.set(value.index, index);
                        meter.observeToolArguments(value.arguments);
                        emit(controller, "content_block_delta", {
                            type: "content_block_delta",
                            index,
                            delta: { type: "input_json_delta", partial_json: value.arguments },
                        });
                        continue;
                    }
                    if (value.type === "finish") {
                        ensureStarted(controller);
                        emitDone(controller, value.reason);
                    }
                }
                ensureStarted(controller);
                emitDone(controller, "stop");
                controller.close();
            }
            catch (error) {
                controller.enqueue(encoder.encode(toSseBlock("error", {
                    type: "error",
                    error: { type: "api_error", message: errorMessageFrom(error) },
                })));
                controller.close();
            }
        },
    });
}

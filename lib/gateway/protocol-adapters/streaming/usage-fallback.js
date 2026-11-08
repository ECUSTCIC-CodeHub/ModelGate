import { countTextTokens } from "@/lib/gateway/tokenizer";
function tokenCount(text, model) {
    return text ? Math.max(0, countTextTokens(text, model)) : 0;
}
function positiveCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
}
// 回给客户端的 SSE usage 兜底：与账务侧共用 countTextTokens（按编码族缓存 encoder）和同一个
// real_model，上游没给 usage 或输出为 0 时补本地分词结果，避免客户端统计到 0。
// 输出侧按协议语义统计正文、推理与工具调用名及参数（纯工具调用时也必须有输出 Token），
// 明细里给出 text_tokens 与 reasoning_tokens。账务侧 resolveTokenUsage 未改动，其
// completion_tokens 只算可见正文、推理单独计入 total 与 output_tps，两边差异仅在这一点。
export function createStreamUsageFallback(options) {
    const localPromptTokens = positiveCount(options?.promptTokens);
    const configuredModel = typeof options?.model === "string" ? options.model : "";
    let text = "";
    let reasoning = "";
    let toolCall = "";
    return {
        localPromptTokens,
        observeText(value) {
            text += value;
        },
        observeReasoning(value) {
            reasoning += value;
        },
        observeToolCall(name, args) {
            if (name)
                toolCall += name;
            if (args)
                toolCall += args;
        },
        // 参数增量与工具名分开记：tool_call_start 之后还有 N 个 tool_call_delta，
        // 若后者把 name 再记一次，同一段工具名会被重复计数
        observeToolArguments(args) {
            if (args)
                toolCall += args;
        },
        complete(remote, fallbackModel) {
            const model = configuredModel || (typeof fallbackModel === "string" ? fallbackModel : "");
            const remotePromptTokens = positiveCount(remote?.prompt_tokens);
            const promptTokens = remotePromptTokens > 0 ? remotePromptTokens : localPromptTokens;
            const remoteCompletionTokens = positiveCount(remote?.completion_tokens);
            const cacheFields = {
                ...(remote?.cache_read_tokens !== undefined ? { cache_read_tokens: remote.cache_read_tokens } : {}),
                ...(remote?.cache_creation_tokens !== undefined ? { cache_creation_tokens: remote.cache_creation_tokens } : {}),
                ...(remote?.cache_miss_tokens !== undefined ? { cache_miss_tokens: remote.cache_miss_tokens } : {}),
            };
            if (remoteCompletionTokens > 0) {
                const totalTokens = Math.max(positiveCount(remote?.total_tokens), promptTokens + remoteCompletionTokens);
                return {
                    prompt_tokens: promptTokens,
                    completion_tokens: remoteCompletionTokens,
                    total_tokens: totalTokens,
                    ...(remote?.text_tokens !== undefined ? { text_tokens: remote.text_tokens } : {}),
                    ...(remote?.reasoning_tokens !== undefined ? { reasoning_tokens: remote.reasoning_tokens } : {}),
                    ...cacheFields,
                };
            }
            const textTokens = tokenCount(text, model);
            const reasoningTokens = tokenCount(reasoning, model);
            const completionTokens = textTokens + reasoningTokens + tokenCount(toolCall, model);
            return {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: Math.max(positiveCount(remote?.total_tokens), promptTokens + completionTokens),
                // 本地兜底时明细与总数同源，避免下游拿 text + reasoning 与 completion 对不上
                ...(textTokens > 0 ? { text_tokens: textTokens } : {}),
                ...(reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : {}),
                ...cacheFields,
            };
        },
    };
}

import { asRecord } from "@/lib/gateway/normalized-message";
import { redactUrlCredentials } from "@/lib/shared/redact";
export function omitKeys(input, keys) {
    const skip = new Set(keys);
    return Object.fromEntries(Object.entries(input).filter(([key]) => !skip.has(key)));
}
export function parseJsonObject(text) {
    return JSON.parse(text);
}
export function parseToolArguments(raw) {
    try {
        return raw ? JSON.parse(raw) : {};
    }
    catch {
        return { raw: raw ?? "" };
    }
}
// 流式错误事件的载荷结构各协议不一（字符串、{message}、{code}），
// 统一提取可读信息，避免把上游限流、内容策略拒绝误报成流被截断
export function upstreamErrorText(value) {
    const record = asRecord(value);
    if (record) {
        if (typeof record.message === "string" && record.message)
            return redactUrlCredentials(record.message);
        if (typeof record.code === "string" && record.code)
            return redactUrlCredentials(record.code);
    }
    if (typeof value === "string" && value)
        return redactUrlCredentials(value);
    return "未知错误";
}
export function finishReasonToAnthropic(value, hasTools) {
    // 截断优先于工具调用：stop_reason 只能取一个值，因长度上限被截断时
    // 即使已产生工具调用也应以 max_tokens 告知调用方
    if (value === "length")
        return "max_tokens";
    if (value === "tool_calls" || hasTools)
        return "tool_use";
    return "end_turn";
}
export function finishReasonFromAnthropic(value, hasTools) {
    if (value === "max_tokens")
        return "length";
    if (value === "tool_use" || hasTools)
        return "tool_calls";
    return "stop";
}
export function normalizeUsage(promptTokens, completionTokens, totalTokens, details) {
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: Math.max(totalTokens ?? 0, promptTokens + completionTokens),
        ...(details?.text_tokens !== undefined ? { text_tokens: details.text_tokens } : {}),
        ...(details?.reasoning_tokens !== undefined ? { reasoning_tokens: details.reasoning_tokens } : {}),
        ...(details?.cache_read_tokens !== undefined ? { cache_read_tokens: details.cache_read_tokens } : {}),
        ...(details?.cache_creation_tokens !== undefined ? { cache_creation_tokens: details.cache_creation_tokens } : {}),
        ...(details?.cache_miss_tokens !== undefined ? { cache_miss_tokens: details.cache_miss_tokens } : {}),
    };
}

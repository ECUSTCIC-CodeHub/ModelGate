import { asArray, asRecord } from "@/lib/gateway/normalized-message";
import { upstreamErrorText } from "@/lib/gateway/protocol-adapters/intermediate";
import { usageFromChatCompletions } from "@/lib/gateway/protocol-adapters/usage";
export function parseChatChunkEvent(data) {
    const parsed = JSON.parse(data);
    const choices = asArray(parsed.choices);
    const firstChoice = asRecord(choices[0]);
    const delta = asRecord(firstChoice?.delta);
    const toolCalls = asArray(delta?.tool_calls)
        .map((item) => {
        const record = asRecord(item);
        const fn = asRecord(record?.function);
        if (!record)
            return null;
        return {
            index: Number(record.index ?? 0),
            id: typeof record.id === "string" ? record.id : "",
            name: typeof fn?.name === "string" ? fn.name : "",
            arguments: typeof fn?.arguments === "string" ? fn.arguments : "",
        };
    })
        .filter((item) => Boolean(item));
    const usage = usageFromChatCompletions(parsed.usage);
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
        usage,
        error: parsed.error !== undefined ? upstreamErrorText(parsed.error) : null,
    };
}
export function trackChatCompletionsStreamEvent(_event, data) {
    const parsed = parseChatChunkEvent(data);
    const tracked = {};
    if (parsed.usage)
        tracked.usage = parsed.usage;
    if (parsed.content)
        tracked.completionText = parsed.content;
    if (parsed.reasoning)
        tracked.reasoningText = parsed.reasoning;
    return tracked.usage || tracked.completionText || tracked.reasoningText || tracked.firstToken ? tracked : null;
}

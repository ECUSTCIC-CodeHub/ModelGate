export function createReasoningOutputItem(reasoningItemId, reasoningText) {
    return {
        id: reasoningItemId,
        type: "reasoning",
        summary: [],
        content: [{ type: "reasoning_text", text: reasoningText }],
        status: "completed",
    };
}
export function createTextOutputItem(outputMessageId, text) {
    return {
        id: outputMessageId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: text ? [{ type: "output_text", text, annotations: [] }] : [],
    };
}
export function createToolOutputItem(tool) {
    return {
        type: "function_call",
        id: tool.itemId,
        call_id: tool.callId,
        name: tool.name,
        arguments: tool.arguments,
        status: "completed",
    };
}

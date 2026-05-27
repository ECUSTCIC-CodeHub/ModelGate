export type EncodedToolState = {
  index: number;
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  outputIndex: number;
  done: boolean;
};

export function createReasoningOutputItem(reasoningItemId: string, reasoningText: string) {
  return {
    id: reasoningItemId,
    type: "reasoning",
    summary: [],
    content: [{ type: "reasoning_text", text: reasoningText }],
    status: "completed",
  };
}

export function createTextOutputItem(outputMessageId: string, text: string) {
  return {
    id: outputMessageId,
    type: "message",
    role: "assistant",
    status: "completed",
    content: text ? [{ type: "output_text", text, annotations: [] }] : [],
  };
}

export function createToolOutputItem(tool: EncodedToolState) {
  return {
    type: "function_call",
    id: tool.itemId,
    call_id: tool.callId,
    name: tool.name,
    arguments: tool.arguments,
    status: "completed",
  };
}

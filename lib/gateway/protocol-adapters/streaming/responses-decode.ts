import { asArray, asRecord, type JsonRecord } from "@/lib/gateway/normalized-message";
import {
  type IntermediateStreamEvent,
  type IntermediateStreamResult,
  type StreamUsage,
} from "@/lib/gateway/protocol-adapters/streaming/common";
import {
  createdToUnix,
  parseResponsesSseEvent,
  usageFromResponses,
} from "@/lib/gateway/protocol-adapters/streaming/responses-events";

type ResponsesToolState = {
  index: number;
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
};

export function decodeResponsesStream(upstream: ReadableStream<Uint8Array>): IntermediateStreamResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  let model: string | null = null;
  let created = Math.floor(Date.now() / 1000);
  let usage: StreamUsage | null = null;
  let completionText = "";
  let reasoningText = "";
  let firstTokenAt: number | null = null;
  let started = false;
  let finished = false;
  let finishReason: string | null = null;
  const toolsByItemId = new Map<string, ResponsesToolState>();
  const toolsByIndex = new Map<number, ResponsesToolState>();

  const markFirstToken = () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  };

  const updateResponseMetadata = (response: JsonRecord | null) => {
    if (!response) return;
    if (typeof response.id === "string") responseId = response.id;
    if (typeof response.model === "string") model = response.model;
    if (response.created_at !== undefined || response.created !== undefined) {
      created = createdToUnix(response.created_at ?? response.created);
    }
    usage = usageFromResponses(response.usage) ?? usage;
    const output = asArray(response.output).map((item) => asRecord(item)).filter((item): item is JsonRecord => Boolean(item));
    if (output.some((item) => item.type === "function_call")) {
      finishReason = "tool_calls";
    }
  };

  const rememberTool = (item: JsonRecord | null, itemId: string, outputIndex: number) => {
    const existing = toolsByItemId.get(itemId);
    if (existing) return existing;

    const callId = typeof item?.call_id === "string"
      ? item.call_id
      : typeof item?.id === "string"
        ? item.id
        : itemId || `call_${crypto.randomUUID().replace(/-/g, "")}`;
    const state: ResponsesToolState = {
      index: outputIndex,
      itemId: typeof item?.id === "string" ? item.id : itemId || callId,
      callId,
      name: typeof item?.name === "string" ? item.name : "",
      arguments: typeof item?.arguments === "string" ? item.arguments : "",
    };
    toolsByItemId.set(state.itemId, state);
    toolsByItemId.set(state.callId, state);
    toolsByIndex.set(state.index, state);
    finishReason = "tool_calls";
    return state;
  };

  const emitMissingToolArguments = (
    controller: ReadableStreamDefaultController<IntermediateStreamEvent>,
    state: ResponsesToolState,
    finalArguments: string,
  ) => {
    const delta = finalArguments.startsWith(state.arguments)
      ? finalArguments.slice(state.arguments.length)
      : finalArguments;
    state.arguments = finalArguments;
    if (!delta) return;
    controller.enqueue({
      type: "tool_call_delta",
      index: state.index,
      id: state.callId,
      name: state.name,
      arguments: delta,
    });
  };

  const emitStart = (controller: ReadableStreamDefaultController<IntermediateStreamEvent>) => {
    if (started) return;
    started = true;
    controller.enqueue({ type: "start", id: responseId, model, created, usage });
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
            updateResponseMetadata(response);

            if (event.event === "response.created" || event.event === "response.in_progress") {
              emitStart(controller);
              continue;
            }

            if (event.event === "response.output_text.delta" && typeof payload?.delta === "string") {
              emitStart(controller);
              markFirstToken();
              completionText += payload.delta;
              controller.enqueue({ type: "text_delta", text: payload.delta });
              continue;
            }

            if (event.event === "response.reasoning_text.delta" && typeof payload?.delta === "string") {
              emitStart(controller);
              markFirstToken();
              reasoningText += payload.delta;
              controller.enqueue({ type: "reasoning_delta", text: payload.delta });
              continue;
            }

            if (event.event === "response.output_item.added") {
              const item = asRecord(payload?.item);
              if (item?.type === "function_call") {
                emitStart(controller);
                const outputIndex = Number(payload?.output_index ?? toolsByIndex.size);
                const itemId = typeof item.id === "string" ? item.id : typeof payload?.item_id === "string" ? payload.item_id : "";
                const tool = rememberTool(item, itemId, outputIndex);
                controller.enqueue({
                  type: "tool_call_start",
                  index: tool.index,
                  id: tool.callId,
                  name: tool.name,
                  arguments: tool.arguments || undefined,
                });
              }
              continue;
            }

            if (event.event === "response.function_call_arguments.delta" && typeof payload?.delta === "string") {
              emitStart(controller);
              const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
              const outputIndex = Number(payload.output_index ?? toolsByIndex.size);
              const tool = toolsByItemId.get(itemId) ?? rememberTool(null, itemId, outputIndex);
              tool.arguments += payload.delta;
              controller.enqueue({
                type: "tool_call_delta",
                index: tool.index,
                id: tool.callId,
                name: tool.name,
                arguments: payload.delta,
              });
              continue;
            }

            if (event.event === "response.function_call_arguments.done" && typeof payload?.arguments === "string") {
              emitStart(controller);
              const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
              const outputIndex = Number(payload.output_index ?? toolsByIndex.size);
              const tool = toolsByItemId.get(itemId) ?? rememberTool(null, itemId, outputIndex);
              emitMissingToolArguments(controller, tool, payload.arguments);
              continue;
            }

            if (event.event === "response.output_item.done") {
              const item = asRecord(payload?.item);
              if (item?.type === "function_call") {
                emitStart(controller);
                const outputIndex = Number(payload?.output_index ?? toolsByIndex.size);
                const itemId = typeof item.id === "string" ? item.id : typeof payload?.item_id === "string" ? payload.item_id : "";
                const tool = toolsByItemId.get(itemId) ?? rememberTool(item, itemId, outputIndex);
                if (typeof item.arguments === "string") {
                  emitMissingToolArguments(controller, tool, item.arguments);
                }
              }
              continue;
            }

            if (event.event === "response.completed") {
              emitStart(controller);
              if (usage) controller.enqueue({ type: "usage", usage });
              if (!finished) {
                finished = true;
                controller.enqueue({ type: "finish", reason: finishReason ?? "stop" });
              }
            }
          }
        }

        if (started && !finished) {
          controller.enqueue({ type: "finish", reason: finishReason ?? "stop" });
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
    reasoningText: () => reasoningText,
    firstTokenAt: () => firstTokenAt,
    usage: () => usage,
  };
}

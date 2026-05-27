import type { IntermediateStreamEvent } from "@/lib/gateway/protocol-adapters/streaming/common";
import { ResponsesStreamWriter } from "@/lib/gateway/protocol-adapters/streaming/responses-encode-writer";

export function encodeResponsesStream(events: ReadableStream<IntermediateStreamEvent>) {
  const reader = events.getReader();
  const writer = new ResponsesStreamWriter(new TextEncoder());

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value.type === "start") {
            writer.applyStart(value, controller);
            continue;
          }

          if (value.type === "usage") {
            writer.applyUsage(value);
            continue;
          }

          if (value.type === "reasoning_delta") {
            writer.writeReasoningDelta(value, controller);
            continue;
          }

          if (value.type === "reasoning_signature") {
            continue;
          }

          if (value.type === "text_delta") {
            writer.writeTextDelta(value, controller);
            continue;
          }

          if (value.type === "tool_call_start") {
            writer.ensureToolCall(value, controller);
            continue;
          }

          if (value.type === "tool_call_delta") {
            writer.writeToolCallDelta(value, controller);
            continue;
          }

          if (value.type === "finish") {
            writer.writeDone(controller);
          }
        }

        writer.writeDone(controller);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

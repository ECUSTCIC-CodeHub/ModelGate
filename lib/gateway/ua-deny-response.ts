import type { GatewayProtocolAdapter } from "@/lib/gateway/protocol-adapters/runtime";
import type {
  IntermediateResponse,
  ResponseAdapterOptions,
} from "@/lib/gateway/protocol-adapters/intermediate";
import { getStreamAdapter } from "@/lib/gateway/protocol-adapters/streaming/registry";
import type { IntermediateStreamEvent } from "@/lib/gateway/protocol-adapters/streaming/common";

const ZERO_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

// 将一段文本包装成与入站协议一致的"助手回复"响应（流式走 SSE，非流式走 JSON），
// 用于 UA 限制等需要让客户端在对话里直接看到提示的场景，而非返回 HTTP 错误。
export function buildSyntheticAssistantResponse(params: {
  inboundAdapter: GatewayProtocolAdapter;
  body: Record<string, unknown>;
  model: string;
  text: string;
  responseOptions?: ResponseAdapterOptions;
}): Response {
  const { inboundAdapter, body, model, text, responseOptions } = params;

  if (inboundAdapter.getStreamFlag(body)) {
    const streamAdapter = getStreamAdapter(inboundAdapter.protocol);
    if (streamAdapter) {
      const events = new ReadableStream<IntermediateStreamEvent>({
        start(controller) {
          controller.enqueue({
            type: "start",
            model,
            created: Math.floor(Date.now() / 1000),
          });
          if (text) {
            controller.enqueue({ type: "text_delta", text });
          }
          controller.enqueue({ type: "finish", reason: "stop" });
          controller.close();
        },
      });
      const encoded = streamAdapter.encode(events, responseOptions);
      return new Response(encoded, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }
  }

  if (!inboundAdapter.bodyAdapter) {
    return new Response(JSON.stringify({ message: text }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const intermediate: IntermediateResponse = {
    sourceProtocol: inboundAdapter.protocol,
    id: `gate_${crypto.randomUUID().replace(/-/g, "")}`,
    model,
    created: Math.floor(Date.now() / 1000),
    role: "assistant",
    content: [{ type: "text", text }],
    tool_calls: [],
    stop_reason: "stop",
    usage: ZERO_USAGE,
    extra: {},
  };
  const json = inboundAdapter.bodyAdapter.responseFromIntermediate(intermediate, responseOptions);
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

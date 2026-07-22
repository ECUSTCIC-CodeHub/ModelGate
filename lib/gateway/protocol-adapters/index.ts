import type { GatewayProtocol } from "@/lib/gateway/protocols";
import { anthropicAdapter, anthropicGatewayAdapter } from "@/lib/gateway/protocol-adapters/anthropic";
import { chatCompletionsAdapter, chatCompletionsGatewayAdapter } from "@/lib/gateway/protocol-adapters/chat-completions";
import { embeddingsGatewayAdapter } from "@/lib/gateway/protocol-adapters/embeddings";
import { imagesGatewayAdapter } from "@/lib/gateway/protocol-adapters/images";
import type { ProtocolBodyAdapter } from "@/lib/gateway/protocol-adapters/intermediate";
import { responsesAdapter, responsesGatewayAdapter } from "@/lib/gateway/protocol-adapters/responses";
import type { GatewayProtocolAdapter } from "@/lib/gateway/protocol-adapters/runtime";

const adapters: Partial<Record<GatewayProtocol, ProtocolBodyAdapter>> = {
  chat_completions: chatCompletionsAdapter,
  responses: responsesAdapter,
  anthropic_messages: anthropicAdapter,
};

const gatewayAdapters: Partial<Record<GatewayProtocol, GatewayProtocolAdapter>> = {
  chat_completions: chatCompletionsGatewayAdapter,
  responses: responsesGatewayAdapter,
  anthropic_messages: anthropicGatewayAdapter,
  embeddings: embeddingsGatewayAdapter,
  images: imagesGatewayAdapter,
};

export function getProtocolBodyAdapter(protocol: GatewayProtocol) {
  const adapter = adapters[protocol];
  if (!adapter) {
    throw new Error(`${protocol} 协议不支持请求体转换`);
  }
  return adapter;
}

export function getGatewayProtocolAdapter(protocol: GatewayProtocol) {
  const adapter = gatewayAdapters[protocol];
  if (!adapter) {
    throw new Error(`协议 ${protocol} 没有对应的网关适配器`);
  }
  return adapter;
}

export {
  anthropicGatewayAdapter,
  chatCompletionsGatewayAdapter,
  embeddingsGatewayAdapter,
  imagesGatewayAdapter,
  responsesGatewayAdapter,
};

export type {
  IntermediateRequest,
  IntermediateResponse,
  IntermediateTool,
  IntermediateToolCall,
  IntermediateToolChoice,
  IntermediateUsage,
  ProtocolBodyAdapter,
  ResponseAdapterOptions,
} from "@/lib/gateway/protocol-adapters/intermediate";
export type { GatewayProtocolAdapter } from "@/lib/gateway/protocol-adapters/runtime";

import type { GatewayProtocol } from "@/lib/gateway/protocols";
import { anthropicAdapter } from "@/lib/gateway/protocol-adapters/anthropic";
import { chatCompletionsAdapter } from "@/lib/gateway/protocol-adapters/chat-completions";
import type { ProtocolBodyAdapter } from "@/lib/gateway/protocol-adapters/intermediate";
import { responsesAdapter } from "@/lib/gateway/protocol-adapters/responses";

const adapters: Partial<Record<GatewayProtocol, ProtocolBodyAdapter>> = {
  chat_completions: chatCompletionsAdapter,
  responses: responsesAdapter,
  anthropic_messages: anthropicAdapter,
};

export function getProtocolBodyAdapter(protocol: GatewayProtocol) {
  const adapter = adapters[protocol];
  if (!adapter) {
    throw new Error(`${protocol} 协议不支持请求体转换`);
  }
  return adapter;
}

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

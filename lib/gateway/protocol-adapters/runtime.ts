import { countTextTokens } from "@/lib/gateway/tokenizer";
import type { GatewayProtocol } from "@/lib/gateway/protocols";
import type { JsonRecord, NormalizedMessage } from "@/lib/gateway/normalized-message";
import type {
  IntermediateResponse,
  IntermediateUsage,
  ProtocolBodyAdapter,
  ResponseAdapterOptions,
} from "@/lib/gateway/protocol-adapters/intermediate";

export type GatewayProtocolAdapter = {
  protocol: GatewayProtocol;
  bodyAdapter?: ProtocolBodyAdapter;
  prepareOutboundRequestBody?: (body: JsonRecord) => JsonRecord;
  estimateRequestTokens(body: JsonRecord): number;
  countPromptTokens(body: JsonRecord, model: string): number;
  getStreamFlag(body: JsonRecord): boolean;
  adaptRequestBody(body: JsonRecord, outbound: GatewayProtocolAdapter, realModel: string): JsonRecord;
  adaptResponseBody(text: string, outbound: GatewayProtocolAdapter, options?: ResponseAdapterOptions): string;
  extractCompletionTextFromBody(text: string): string;
  extractReasoningTextFromBody(text: string): string;
  getUsageFromBody(text: string): IntermediateUsage | null;
};

export function inputTextFromMessages(messages: NormalizedMessage[]) {
  return messages
    .flatMap((message) => message.content)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function createBodyProtocolGatewayAdapter(options: {
  protocol: Exclude<GatewayProtocol, "embeddings">;
  bodyAdapter: ProtocolBodyAdapter;
  getInputText(body: JsonRecord): string;
  getMaxOutputTokens(body: JsonRecord): unknown;
  prepareOutboundRequestBody?: (body: JsonRecord) => JsonRecord;
}): GatewayProtocolAdapter {
  const { protocol, bodyAdapter, getInputText, getMaxOutputTokens, prepareOutboundRequestBody } = options;

  return {
    protocol,
    bodyAdapter,
    prepareOutboundRequestBody,
    estimateRequestTokens(body) {
      const maxTokens = Number(getMaxOutputTokens(body) ?? 256);
      const outputReserve = Number.isFinite(maxTokens) ? Math.max(0, maxTokens) : 256;
      return Math.max(1, Math.ceil(getInputText(body).length / 4) + Math.min(outputReserve, 4096));
    },
    countPromptTokens(body, model) {
      return Math.max(0, countTextTokens(getInputText(body), model));
    },
    getStreamFlag(body) {
      return body.stream === true;
    },
    adaptRequestBody(body, outbound, realModel) {
      const prepare = (requestBody: JsonRecord) => outbound.prepareOutboundRequestBody?.(requestBody) ?? requestBody;
      if (outbound.protocol === protocol) {
        return prepare({
          ...body,
          model: realModel,
        });
      }

      if (!outbound.bodyAdapter) {
        throw new Error(`${protocol} 协议不能转换为 ${outbound.protocol} 请求`);
      }

      const intermediate = bodyAdapter.requestToIntermediate(body, realModel);
      return prepare(outbound.bodyAdapter.requestFromIntermediate(intermediate));
    },
    adaptResponseBody(text, outbound, responseOptions) {
      if (outbound.protocol === protocol) return text;
      if (!outbound.bodyAdapter) {
        throw new Error(`${outbound.protocol} 协议响应不能转换为 ${protocol}`);
      }

      const parsed = JSON.parse(text) as JsonRecord;
      const intermediate = outbound.bodyAdapter.responseToIntermediate(parsed);
      return JSON.stringify(bodyAdapter.responseFromIntermediate(intermediate, responseOptions));
    },
    extractCompletionTextFromBody(text) {
      try {
        const parsed = JSON.parse(text) as JsonRecord;
        const response: IntermediateResponse = bodyAdapter.responseToIntermediate(parsed);
        return response.content
          .flatMap((part) => {
            if (part.type === "text") return [part.text];
            return [];
          })
          .join("\n");
      } catch {
        return "";
      }
    },
    extractReasoningTextFromBody(text) {
      try {
        const parsed = JSON.parse(text) as JsonRecord;
        const response: IntermediateResponse = bodyAdapter.responseToIntermediate(parsed);
        return response.content
          .flatMap((part) => (part.type === "thinking" ? [part.thinking] : []))
          .join("\n");
      } catch {
        return "";
      }
    },
    getUsageFromBody(text) {
      try {
        const parsed = JSON.parse(text) as JsonRecord;
        return bodyAdapter.responseToIntermediate(parsed).usage;
      } catch {
        return null;
      }
    },
  };
}

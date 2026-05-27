import type { JsonRecord } from "@/lib/gateway/normalized-message";
import type { GatewayProtocolAdapter } from "@/lib/gateway/protocol-adapters/runtime";

function estimateEmbeddingInputTokens(input: unknown): number {
  if (typeof input === "string") return Math.ceil(input.length / 4);
  if (typeof input === "number") return Number.isFinite(input) ? 1 : 0;
  if (Array.isArray(input)) {
    return input.reduce((total, item) => total + estimateEmbeddingInputTokens(item), 0);
  }
  return 0;
}

export const embeddingsGatewayAdapter: GatewayProtocolAdapter = {
  protocol: "embeddings",
  estimateRequestTokens(body) {
    return Math.max(1, estimateEmbeddingInputTokens(body.input));
  },
  countPromptTokens(body) {
    return Math.max(0, estimateEmbeddingInputTokens(body.input));
  },
  getStreamFlag() {
    return false;
  },
  adaptRequestBody(body: JsonRecord, outbound, realModel) {
    if (outbound.protocol !== "embeddings") {
      throw new Error("Embeddings 协议只支持原样转发请求");
    }
    return {
      ...body,
      model: realModel,
    };
  },
  adaptResponseBody(text, outbound) {
    if (outbound.protocol !== "embeddings") {
      throw new Error("Embeddings 协议只支持原样转发响应");
    }
    return text;
  },
  extractCompletionTextFromBody() {
    return "";
  },
  getUsageFromBody(text) {
    try {
      const parsed = JSON.parse(text) as JsonRecord;
      const usage = parsed.usage && typeof parsed.usage === "object" && !Array.isArray(parsed.usage)
        ? (parsed.usage as JsonRecord)
        : null;
      if (!usage) return null;
      const promptTokens = Number(usage.prompt_tokens ?? 0);
      const totalTokens = Number(usage.total_tokens ?? promptTokens);
      return { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: totalTokens };
    } catch {
      return null;
    }
  },
};

import type { JsonRecord } from "@/lib/gateway/normalized-message";
import type { GatewayProtocolAdapter } from "@/lib/gateway/protocol-adapters/runtime";

function estimateImageInputTokens(body: JsonRecord): number {
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  return Math.max(1, Math.ceil(prompt.length / 4));
}

export const imagesGatewayAdapter: GatewayProtocolAdapter = {
  protocol: "images",
  estimateRequestTokens(body) {
    return estimateImageInputTokens(body);
  },
  countPromptTokens(body) {
    return estimateImageInputTokens(body);
  },
  getStreamFlag() {
    return false;
  },
  adaptRequestBody(body: JsonRecord, outbound, realModel) {
    if (outbound.protocol !== "images") {
      throw new Error("Images 协议只支持原样转发请求");
    }
    return {
      ...body,
      model: realModel,
    };
  },
  adaptResponseBody(text, outbound) {
    if (outbound.protocol !== "images") {
      throw new Error("Images 协议只支持原样转发响应");
    }
    return text;
  },
  extractCompletionTextFromBody() {
    return "";
  },
  getUsageFromBody() {
    return null;
  },
};

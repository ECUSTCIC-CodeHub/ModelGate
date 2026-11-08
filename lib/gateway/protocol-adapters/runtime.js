import { countTextTokens } from "@/lib/gateway/tokenizer";
import { omitKeys, } from "@/lib/gateway/protocol-adapters/intermediate";
import { downgradeResponsesRequestForRoute } from "@/lib/gateway/protocol-adapters/tools";
export function inputTextFromMessages(messages) {
    return messages
        .flatMap((message) => message.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}
export function createBodyProtocolGatewayAdapter(options) {
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
        adaptRequestBody(body, outbound, realModel, forceIncludeUsage = true) {
            const prepare = (requestBody) => {
                const prepared = outbound.prepareOutboundRequestBody?.(requestBody) ?? requestBody;
                if (prepared.stream === true && outbound.protocol === "chat_completions") {
                    const streamOptions = typeof prepared.stream_options === "object" && prepared.stream_options !== null && !Array.isArray(prepared.stream_options)
                        ? prepared.stream_options
                        : {};
                    if (forceIncludeUsage) {
                        return { ...prepared, stream_options: { ...streamOptions, include_usage: true } };
                    }
                    if ("include_usage" in streamOptions) {
                        const rest = omitKeys(streamOptions, ["include_usage"]);
                        return { ...prepared, stream_options: Object.keys(rest).length > 0 ? rest : undefined };
                    }
                }
                return prepared;
            };
            if (outbound.protocol === protocol) {
                return prepare({
                    ...body,
                    model: realModel,
                });
            }
            if (!outbound.bodyAdapter) {
                throw new Error(`${protocol} 协议不能转换为 ${outbound.protocol} 请求`);
            }
            const adaptedInput = protocol === "responses"
                ? downgradeResponsesRequestForRoute(body, outbound.protocol)
                : body;
            const intermediate = bodyAdapter.requestToIntermediate(adaptedInput, realModel);
            return prepare(outbound.bodyAdapter.requestFromIntermediate(intermediate));
        },
        adaptResponseBody(text, outbound, responseOptions) {
            if (outbound.protocol === protocol)
                return text;
            if (!outbound.bodyAdapter) {
                throw new Error(`${outbound.protocol} 协议响应不能转换为 ${protocol}`);
            }
            const parsed = JSON.parse(text);
            const intermediate = outbound.bodyAdapter.responseToIntermediate(parsed);
            return JSON.stringify(bodyAdapter.responseFromIntermediate(intermediate, responseOptions));
        },
        extractCompletionTextFromBody(text) {
            try {
                const parsed = JSON.parse(text);
                const response = bodyAdapter.responseToIntermediate(parsed);
                return response.content
                    .flatMap((part) => {
                    if (part.type === "text")
                        return [part.text];
                    return [];
                })
                    .join("\n");
            }
            catch {
                return "";
            }
        },
        extractReasoningTextFromBody(text) {
            try {
                const parsed = JSON.parse(text);
                const response = bodyAdapter.responseToIntermediate(parsed);
                return response.content
                    .flatMap((part) => (part.type === "thinking" ? [part.thinking] : []))
                    .join("\n");
            }
            catch {
                return "";
            }
        },
        getUsageFromBody(text) {
            try {
                const parsed = JSON.parse(text);
                return bodyAdapter.responseToIntermediate(parsed).usage;
            }
            catch {
                return null;
            }
        },
    };
}

export const GATEWAY_PROTOCOLS = ["chat_completions", "responses", "anthropic_messages", "embeddings", "images", "other"];
const DEFAULT_PROTOCOLS = ["chat_completions"];
export function isGatewayProtocol(value) {
    return typeof value === "string" && GATEWAY_PROTOCOLS.includes(value);
}
export function parseSupportedProtocols(raw) {
    if (!raw)
        return [...DEFAULT_PROTOCOLS];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [...DEFAULT_PROTOCOLS];
        const normalized = parsed.filter(isGatewayProtocol);
        return normalized.length > 0 ? [...new Set(normalized)] : [...DEFAULT_PROTOCOLS];
    }
    catch {
        return [...DEFAULT_PROTOCOLS];
    }
}
export function stringifySupportedProtocols(protocols) {
    const normalized = [...new Set(protocols.filter(isGatewayProtocol))];
    return JSON.stringify(normalized.length > 0 ? normalized : DEFAULT_PROTOCOLS);
}
export function normalizeSupportedProtocols(value) {
    if (!Array.isArray(value))
        return [...DEFAULT_PROTOCOLS];
    const normalized = value.filter(isGatewayProtocol);
    return normalized.length > 0 ? [...new Set(normalized)] : [...DEFAULT_PROTOCOLS];
}
export function supportsProtocol(raw, protocol) {
    return parseSupportedProtocols(raw).includes(protocol);
}

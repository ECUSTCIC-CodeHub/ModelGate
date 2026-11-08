export const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_KEY = "modelsDevCatalog";
// 渠道的 supported_protocols 只接受这几种网关协议
const GATEWAY_PROTOCOLS = [
    "chat_completions",
    "anthropic_messages",
    "responses",
    "embeddings",
    "other",
];
function isProtocol(value) {
    return GATEWAY_PROTOCOLS.includes(value);
}
// npm 包名决定该 provider 的协议组合。
// openai 同时支持 responses：很多 OpenAI 兼容渠道两者都可用，由用户在草稿里自行去掉多余的
export function protocolsFromNpm(npm) {
    if (typeof npm !== "string")
        return ["chat_completions"];
    if (npm === "@ai-sdk/anthropic")
        return ["anthropic_messages"];
    if (npm === "@ai-sdk/openai")
        return ["chat_completions", "responses"];
    return ["chat_completions"];
}
// 单个模型的协议推导：embeddings 优先，其次非纯文本输出走 other，否则用 provider 首选协议
export function protocolForModel(model, providerProtocols) {
    const haystack = `${typeof model.id === "string" ? model.id : ""} ${typeof model.name === "string" ? model.name : ""}`.toLowerCase();
    if (haystack.includes("embedding"))
        return "embeddings";
    const output = model.modalities?.output;
    if (Array.isArray(output)) {
        const modalities = output.filter((item) => typeof item === "string");
        if (modalities.length > 0 && modalities.some((item) => item !== "text"))
            return "other";
    }
    return providerProtocols[0] ?? "chat_completions";
}
export function parseModelsDevCatalog(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return [];
    const providers = [];
    for (const [providerId, value] of Object.entries(raw)) {
        if (!value || typeof value !== "object" || Array.isArray(value))
            continue;
        const provider = value;
        const protocols = protocolsFromNpm(provider.npm);
        if (!provider.models || typeof provider.models !== "object" || Array.isArray(provider.models))
            continue;
        const models = [];
        for (const [modelId, modelValue] of Object.entries(provider.models)) {
            if (!modelValue || typeof modelValue !== "object" || Array.isArray(modelValue))
                continue;
            const model = modelValue;
            const id = typeof model.id === "string" && model.id.trim() ? model.id.trim() : modelId;
            const name = typeof model.name === "string" && model.name.trim() ? model.name.trim() : id;
            const rawOutput = model.modalities?.output;
            const outputModalities = Array.isArray(rawOutput)
                ? rawOutput.filter((item) => typeof item === "string")
                : [];
            models.push({ id, name, outputModalities });
        }
        if (models.length === 0)
            continue;
        models.sort((a, b) => a.id.localeCompare(b.id));
        providers.push({ providerId, label: providerId, protocols, models });
    }
    providers.sort((a, b) => a.providerId.localeCompare(b.providerId));
    return providers;
}
export function filterModelsDevProviders(providers, query) {
    const q = query.trim().toLowerCase();
    if (!q)
        return providers;
    return providers
        .map((provider) => {
        if (provider.providerId.toLowerCase().includes(q))
            return provider;
        const models = provider.models.filter((model) => model.id.toLowerCase().includes(q) || model.name.toLowerCase().includes(q));
        return models.length > 0 ? { ...provider, models } : null;
    })
        .filter((provider) => provider !== null);
}
// sessionStorage 缓存，避免每次打开抽屉都拉一遍；解析失败或结构变化时回退到重新拉取
export function readModelsDevCache() {
    if (typeof window === "undefined")
        return null;
    try {
        const raw = sessionStorage.getItem(CACHE_KEY);
        if (!raw)
            return null;
        const providers = parseModelsDevCatalog(JSON.parse(raw));
        return providers.length > 0 ? providers : null;
    }
    catch {
        return null;
    }
}
export function writeModelsDevCache(raw) {
    if (typeof window === "undefined")
        return;
    try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(raw));
    }
    catch {
        // 缓存写入失败不影响本次使用
    }
}
export function clearModelsDevCache() {
    if (typeof window === "undefined")
        return;
    try {
        sessionStorage.removeItem(CACHE_KEY);
    }
    catch {
        // 忽略
    }
}
export { isProtocol };

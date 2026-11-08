import { normalizeRetryStatusCodes } from "@/lib/gateway/upstream-error";
export const protocolOptions = [
    { value: "chat_completions", label: "Chat Completions", shortLabel: "Chat" },
    { value: "responses", label: "Responses", shortLabel: "Responses" },
    { value: "anthropic_messages", label: "Claude Messages", shortLabel: "Claude" },
    { value: "embeddings", label: "Embeddings", shortLabel: "Embeddings" },
    { value: "images", label: "Images", shortLabel: "Images" },
    { value: "other", label: "Other 通用转发", shortLabel: "Other" },
];
export function isProtocol(value) {
    return value === "chat_completions" || value === "responses" || value === "anthropic_messages" || value === "embeddings" || value === "images" || value === "other";
}
export function protocolLabel(protocol) {
    return protocolOptions.find((option) => option.value === protocol)?.label ?? "Chat Completions";
}
export function shortProtocolLabel(protocol) {
    return protocolOptions.find((option) => option.value === protocol)?.shortLabel ?? "Chat";
}
export function parseSupportedProtocols(raw) {
    if (!raw)
        return ["chat_completions"];
    try {
        const parsed = JSON.parse(raw);
        const normalized = Array.isArray(parsed) ? parsed.filter(isProtocol) : [];
        return normalized.length > 0 ? normalized : ["chat_completions"];
    }
    catch {
        return ["chat_completions"];
    }
}
export const QUOTA_MODE_OPTIONS = [
    { value: "follow_group", label: "跟随用户组", description: "受用户组配额和速率限制约束" },
    { value: "bypass_group", label: "绕过用户组", description: "不受用户组配额和速率限制约束" },
    { value: "independent", label: "独立配额", description: "不受用户组限制，使用模型自身配额" },
    { value: "dual", label: "双重限制", description: "受用户组配额和速率限制，同时受模型自身配额限制" },
];
export const initialChannelForm = {
    name: "",
    base_url: "",
    api_key: "",
    api_key_private: false,
    user_agent: "",
    proxy_url: "",
    supported_protocols: ["chat_completions"],
    weight: 1,
    max_concurrency: 64,
    timeout: 60,
    quota_tokens: "",
    quota_requests: "",
    period_cycles: [],
    force_include_usage: true,
    ua_restrictions: "",
    expires_at: "",
    time_restrictions: "",
    custom_headers: "",
    request_body_omit: "",
    group_name: "",
    retry_status_codes: "",
};
export const initialModelDraft = {
    alias: "",
    real_model: "",
    upstream_protocol: "chat_completions",
    supported_protocols: ["chat_completions"],
    copilot_compatibility: false,
    supports_vision: false,
    is_public: true,
    weight: 1,
    token_multiplier: 1,
    request_multiplier: 1,
    max_concurrency: 0,
    quota_mode: "follow_group",
    enabled: true,
};
export const initialModelForm = {
    alias: "",
    real_model: "",
    channel_id: 0,
    upstream_protocol: "chat_completions",
    supported_protocols: ["chat_completions"],
    copilot_compatibility: false,
    supports_vision: false,
    is_public: true,
    weight: 1,
    token_multiplier: 1,
    request_multiplier: 1,
    max_concurrency: 0,
    quota_mode: "follow_group",
    quota_tokens: "",
    quota_requests: "",
    period_cycles: [],
    multiplier_schedules: [],
    enabled: true,
    ua_restrictions: "",
    expires_at: "",
    system_prompt: "",
    retry_status_codes: "",
};
// 落库是状态码 JSON 数组文本，表单里按「逗号分隔」编辑。
// 模型级与渠道级共用：用统一归一化过滤脏值，避免越界/非整数回显后在保存时静默收窄。
export function formatRetryStatusCodesInput(raw) {
    if (typeof raw !== "string" || raw.trim() === "")
        return "";
    try {
        const codes = normalizeRetryStatusCodes(JSON.parse(raw));
        return codes ? codes.join(",") : "";
    }
    catch {
        return "";
    }
}

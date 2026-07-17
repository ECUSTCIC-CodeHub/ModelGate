export type Protocol = "chat_completions" | "responses" | "anthropic_messages" | "embeddings" | "images";

export const protocolOptions: Array<{ value: Protocol; label: string; shortLabel: string }> = [
  { value: "chat_completions", label: "Chat Completions", shortLabel: "Chat" },
  { value: "responses", label: "Responses", shortLabel: "Responses" },
  { value: "anthropic_messages", label: "Claude Messages", shortLabel: "Claude" },
  { value: "embeddings", label: "Embeddings", shortLabel: "Embeddings" },
  { value: "images", label: "Images", shortLabel: "Images" },
];

export function isProtocol(value: unknown): value is Protocol {
  return value === "chat_completions" || value === "responses" || value === "anthropic_messages" || value === "embeddings" || value === "images";
}

export function protocolLabel(protocol: Protocol) {
  return protocolOptions.find((option) => option.value === protocol)?.label ?? "Chat Completions";
}

export function shortProtocolLabel(protocol: Protocol) {
  return protocolOptions.find((option) => option.value === protocol)?.shortLabel ?? "Chat";
}

export function parseSupportedProtocols(raw: string | null | undefined): Protocol[] {
  if (!raw) return ["chat_completions"];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const normalized = Array.isArray(parsed) ? parsed.filter(isProtocol) : [];
    return normalized.length > 0 ? normalized : ["chat_completions"];
  } catch {
    return ["chat_completions"];
  }
}

export const PERIOD_PRESETS = [
  { label: "不限制", value: "" },
  { label: "每小时", value: "3600" },
  { label: "每日", value: "86400" },
  { label: "每周", value: "604800" },
  { label: "每月", value: "2592000" },
  { label: "自定义", value: "custom" },
] as const;

export function periodToPreset(v: number | null): string {
  if (v === null || v <= 0) return "";
  if (v === 3600) return "3600";
  if (v === 86400) return "86400";
  if (v === 604800) return "604800";
  if (v === 2592000) return "2592000";
  return "custom";
}

export type ModelQuotaMode = "follow_group" | "bypass_group" | "independent";

export const QUOTA_MODE_OPTIONS: Array<{ value: ModelQuotaMode; label: string; description: string }> = [
  { value: "follow_group", label: "跟随用户组", description: "受用户组配额和速率限制约束" },
  { value: "bypass_group", label: "绕过用户组", description: "不受用户组配额和速率限制约束" },
  { value: "independent", label: "独立配额", description: "不受用户组限制，使用模型自身配额" },
];

export type ModelRow = {
  id: number;
  alias: string;
  real_model: string;
  channel_id: number;
  upstream_protocol: Protocol;
  supported_protocols: string;
  copilot_compatibility: number;
  is_public: number;
  enabled: number;
  weight: number;
  token_multiplier: number;
  request_multiplier: number;
  max_concurrency: number;
  quota_mode: ModelQuotaMode;
  quota_tokens: number | null;
  quota_requests: number | null;
  quota_period: number | null;
  period_quota_tokens: number | null;
  period_quota_requests: number | null;
  ua_restrictions: string;
};

export type Channel = {
  id: number;
  name: string;
  base_url: string;
  api_key: string | null;
  supported_protocols: string;
  user_agent: string;
  proxy_url: string;
  enabled: number;
  weight: number;
  max_concurrency: number;
  timeout: number;
  quota_tokens: number | null;
  quota_requests: number | null;
  quota_period: number | null;
  period_quota_tokens: number | null;
  period_quota_requests: number | null;
  force_include_usage: number;
  ua_restrictions: string;
  created_by?: number | null;
  created_by_username?: string | null;
  api_key_private?: number | null;
  can_view_api_key?: boolean;
  can_manage_api_key_privacy?: boolean;
  models?: ModelRow[];
};

export type ChannelModelDraft = {
  alias: string;
  real_model: string;
  upstream_protocol: Protocol;
  supported_protocols: Protocol[];
  copilot_compatibility: boolean;
  is_public: boolean;
  weight: number;
  token_multiplier: number;
  request_multiplier: number;
  max_concurrency: number;
  quota_mode: ModelQuotaMode;
  enabled: boolean;
};

export type ChannelForm = {
  name: string;
  base_url: string;
  api_key: string;
  api_key_private: boolean;
  user_agent: string;
  proxy_url: string;
  supported_protocols: Protocol[];
  weight: number;
  max_concurrency: number;
  timeout: number;
  quota_tokens: string;
  quota_requests: string;
  quota_period_preset: string;
  quota_period_custom: string;
  period_quota_tokens: string;
  period_quota_requests: string;
  force_include_usage: boolean;
  ua_restrictions: string;
};

export type ModelForm = {
  alias: string;
  real_model: string;
  channel_id: number;
  upstream_protocol: Protocol;
  supported_protocols: Protocol[];
  copilot_compatibility: boolean;
  is_public: boolean;
  weight: number;
  token_multiplier: number;
  request_multiplier: number;
  max_concurrency: number;
  quota_mode: ModelQuotaMode;
  quota_tokens: string;
  quota_requests: string;
  quota_period_preset: string;
  quota_period_custom: string;
  period_quota_tokens: string;
  period_quota_requests: string;
  enabled: boolean;
  ua_restrictions: string;
};

export type UpstreamModelOption = {
  id: string;
  selected: boolean;
  disabled: boolean;
};

export type ModelWithChannel = ModelRow & {
  channel_name: string;
  channel_weight: number;
};

export const initialChannelForm: ChannelForm = {
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
  quota_period_preset: "",
  quota_period_custom: "",
  period_quota_tokens: "",
  period_quota_requests: "",
  force_include_usage: true,
  ua_restrictions: "",
};

export const initialModelDraft: ChannelModelDraft = {
  alias: "",
  real_model: "",
  upstream_protocol: "chat_completions",
  supported_protocols: ["chat_completions"],
  copilot_compatibility: false,
  is_public: true,
  weight: 1,
  token_multiplier: 1,
  request_multiplier: 1,
  max_concurrency: 0,
  quota_mode: "follow_group",
  enabled: true,
};

export const initialModelForm: ModelForm = {
  alias: "",
  real_model: "",
  channel_id: 0,
  upstream_protocol: "chat_completions",
  supported_protocols: ["chat_completions"],
  copilot_compatibility: false,
  is_public: true,
  weight: 1,
  token_multiplier: 1,
  request_multiplier: 1,
  max_concurrency: 0,
  quota_mode: "follow_group",
  quota_tokens: "",
  quota_requests: "",
  quota_period_preset: "",
  quota_period_custom: "",
  period_quota_tokens: "",
  period_quota_requests: "",
  enabled: true,
  ua_restrictions: "",
};

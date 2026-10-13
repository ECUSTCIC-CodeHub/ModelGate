import { normalizeRetryStatusCodes } from "@/lib/gateway/upstream-error";
import type { PeriodCycleDraft } from "@/app/dashboard/period-cycle-fields";
import type { MultiplierScheduleDraft } from "@/app/dashboard/multiplier-schedule-fields";

export type Protocol = "chat_completions" | "responses" | "anthropic_messages" | "embeddings" | "images" | "other";

export const protocolOptions: Array<{ value: Protocol; label: string; shortLabel: string }> = [
  { value: "chat_completions", label: "Chat Completions", shortLabel: "Chat" },
  { value: "responses", label: "Responses", shortLabel: "Responses" },
  { value: "anthropic_messages", label: "Claude Messages", shortLabel: "Claude" },
  { value: "embeddings", label: "Embeddings", shortLabel: "Embeddings" },
  { value: "images", label: "Images", shortLabel: "Images" },
  { value: "other", label: "Other 通用转发", shortLabel: "Other" },
];

export function isProtocol(value: unknown): value is Protocol {
  return value === "chat_completions" || value === "responses" || value === "anthropic_messages" || value === "embeddings" || value === "images" || value === "other";
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

export type ModelQuotaMode = "follow_group" | "bypass_group" | "independent" | "dual";

export const QUOTA_MODE_OPTIONS: Array<{ value: ModelQuotaMode; label: string; description: string }> = [
  { value: "follow_group", label: "跟随用户组", description: "受用户组配额和速率限制约束" },
  { value: "bypass_group", label: "绕过用户组", description: "不受用户组配额和速率限制约束" },
  { value: "independent", label: "独立配额", description: "不受用户组限制，使用模型自身配额" },
  { value: "dual", label: "双重限制", description: "受用户组配额和速率限制，同时受模型自身配额限制" },
];

export type ModelRow = {
  id: number;
  alias: string;
  real_model: string;
  channel_id: number;
  upstream_protocol: Protocol;
  supported_protocols: string;
  copilot_compatibility: number;
  supports_vision: number;
  is_public: number;
  enabled: number;
  weight: number;
  token_multiplier: number;
  request_multiplier: number;
  max_concurrency: number;
  quota_mode: ModelQuotaMode;
  quota_tokens: number | null;
  quota_requests: number | null;
  ua_restrictions: string;
  expires_at: string | null;
  system_prompt: string | null;
  period_cycles: string | null;
  multiplier_schedules: string | null;
  retry_status_codes: string | null;
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
  force_include_usage: number;
  ua_restrictions: string;
  expires_at: string | null;
  time_restrictions: string;
  custom_headers: string;
  request_body_omit: string;
  period_cycles: string | null;
  group_name: string;
  retry_status_codes: string | null;
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
  supports_vision: boolean;
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
  period_cycles: PeriodCycleDraft[];
  force_include_usage: boolean;
  ua_restrictions: string;
  expires_at: string;
  time_restrictions: string;
  custom_headers: string;
  request_body_omit: string;
  group_name: string;
  retry_status_codes: string;
};

export type ModelForm = {
  alias: string;
  real_model: string;
  channel_id: number;
  upstream_protocol: Protocol;
  supported_protocols: Protocol[];
  copilot_compatibility: boolean;
  supports_vision: boolean;
  is_public: boolean;
  weight: number;
  token_multiplier: number;
  request_multiplier: number;
  max_concurrency: number;
  quota_mode: ModelQuotaMode;
  quota_tokens: string;
  quota_requests: string;
  period_cycles: PeriodCycleDraft[];
  multiplier_schedules: MultiplierScheduleDraft[];
  enabled: boolean;
  ua_restrictions: string;
  expires_at: string;
  system_prompt: string;
  retry_status_codes: string;
};

export type UpstreamModelOption = {
  id: string;
  selected: boolean;
  disabled: boolean;
};

export type StaleModelRow = {
  id: number;
  alias: string;
  real_model: string;
  enabled: number;
  alias_match: boolean;
};

export type StaleModelsResult = {
  channel_id: number;
  channel_name: string;
  upstream_count: number;
  local_count: number;
  kept: number;
  skipped_wildcard: number;
  stale: StaleModelRow[];
  missing_upstream: string[];
};

export type ModelWithChannel = ModelRow & {
  channel_name: string;
  channel_weight: number;
  channel_enabled: number;
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

export const initialModelDraft: ChannelModelDraft = {
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

export const initialModelForm: ModelForm = {
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
export function formatRetryStatusCodesInput(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return "";
  try {
    const codes = normalizeRetryStatusCodes(JSON.parse(raw));
    return codes ? codes.join(",") : "";
  } catch {
    return "";
  }
}

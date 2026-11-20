import { normalizeRetryStatusCodes } from "@/lib/gateway/upstream-error";
import { parseMultiplierSchedules, resolveLayeredMultiplier, type MultiplierSchedule } from "@/lib/gateway/multiplier-schedule";
import type { PeriodCycleDraft } from "@/app/dashboard/period-cycle-fields";
import type { MultiplierScheduleDraft } from "@/lib/shared/multiplier-schedule-tz";
import type { WallClockWindow } from "@/lib/shared/time-window";
import { browserTimeZone } from "@/lib/shared/timezone";

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

// 渠道级与模型级共用四种模式，但「自身配额」指渠道自己的 quota_* 与周期档，
// 默认 dual 与历史行为一致：渠道配额与用户组限制同时生效。
export const CHANNEL_QUOTA_MODE_OPTIONS: Array<{ value: ModelQuotaMode; label: string; description: string }> = [
  { value: "follow_group", label: "跟随用户组", description: "仅受用户组配额和速率限制，渠道自身配额不生效" },
  { value: "bypass_group", label: "绕过用户组", description: "不受用户组配额和速率限制，渠道自身配额也不生效" },
  { value: "independent", label: "独立配额", description: "不受用户组限制，仅检查渠道自身配额；未填写任何渠道配额时不限制" },
  { value: "dual", label: "双重限制", description: "受用户组配额和速率限制，同时受渠道自身配额限制（默认，与历史行为一致）" },
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
  quota_mode: ModelQuotaMode;
  quota_tokens: number | null;
  quota_requests: number | null;
  force_include_usage: number;
  ua_restrictions: string;
  expires_at: string | null;
  time_restrictions: string;
  custom_headers: string;
  request_body_omit: string;
  header_mappings: string | null;
  period_cycles: string | null;
  group_name: string;
  retry_status_codes: string | null;
  multiplier_schedules: string | null;
  // 渠道分时档的解析结果（GET /api/admin/channels 下发），模型侧展示生效倍率时要用
  multiplier_schedule_list?: MultiplierSchedule[];
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
  quota_mode: ModelQuotaMode;
  quota_tokens: string;
  quota_requests: string;
  period_cycles: PeriodCycleDraft[];
  force_include_usage: boolean;
  ua_restrictions: string;
  expires_at: string;
  // 表单里存墙上时间的行，提交时按 time_restrictions_time_zone 换算成 UTC JSON；
  // 时区只是表单态，不提交给服务端
  time_restrictions: WallClockWindow[];
  time_restrictions_time_zone: string;
  custom_headers: string;
  request_body_omit: string;
  header_mappings: string;
  group_name: string;
  retry_status_codes: string;
  multiplier_schedules: MultiplierScheduleDraft[];
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
  channel_multiplier_schedules: MultiplierSchedule[];
};

export type ModelEffectiveMultiplier = {
  token_multiplier: number;
  request_multiplier: number;
  schedule_applied: boolean;
  // 该维度由模型自己的分时档决定（否则由渠道档补足或就是基础倍率）
  token_from_model_schedule: boolean;
  request_from_model_schedule: boolean;
  // 该维度命中了分时档（不论哪一层）。两者都为假时该维度的值就是基础倍率。
  token_scheduled: boolean;
  request_scheduled: boolean;
};

// 模型映射列表要回答「这条线此刻什么价」，与计费必须同口径，所以直接用网关的同一份分层解析，
// 不在管理端另写一遍「模型档优先、渠道档补空维度」。
export function effectiveMultiplierOf(model: ModelRow & { channel_multiplier_schedules: MultiplierSchedule[] }): ModelEffectiveMultiplier {
  const resolved = resolveLayeredMultiplier(
    model.token_multiplier ?? 1,
    model.request_multiplier ?? 1,
    [parseMultiplierSchedules(model.multiplier_schedules), model.channel_multiplier_schedules],
  );
  return {
    token_multiplier: resolved.token_multiplier,
    request_multiplier: resolved.request_multiplier,
    schedule_applied: resolved.schedule_applied,
    token_from_model_schedule: resolved.token_source === 0,
    request_from_model_schedule: resolved.request_source === 0,
    token_scheduled: resolved.token_source !== null,
    request_scheduled: resolved.request_source !== null,
  };
}

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
  quota_mode: "dual",
  quota_tokens: "",
  quota_requests: "",
  period_cycles: [],
  force_include_usage: true,
  ua_restrictions: "",
  expires_at: "",
  time_restrictions: [],
  time_restrictions_time_zone: browserTimeZone(),
  custom_headers: "",
  request_body_omit: "",
  header_mappings: "",
  group_name: "",
  retry_status_codes: "",
  multiplier_schedules: [],
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

export type GroupRow = {
  id: number;
  name: string;
  description: string | null;
  qps: number;
  rpm: number;
  tpm: number;
  quota_requests: number | null;
  quota_tokens: number | null;
  quota_period: number | null;
  period_quota_tokens: number | null;
  period_quota_requests: number | null;
  allowed_model_aliases: string[];
  allowed_channel_ids: number[];
  oidc_claim_expr: string | null;
  oidc_claim_priority: number;
  is_default: number;
  enabled: number;
  user_count: number;
};

export type AliasOption = {
  id: number;
  alias: string;
  is_public: number;
};

export type ChannelOption = {
  id: number;
  name: string;
  enabled: number;
};

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

export function formatPeriodLabel(v: number | null): string {
  if (v === null || v <= 0) return "-";
  const preset = PERIOD_PRESETS.find((p) => p.value === String(v));
  if (preset) return preset.label;
  if (v >= 86400) return `每 ${Math.round(v / 86400)} 天`;
  if (v >= 3600) return `每 ${Math.round(v / 3600)} 小时`;
  return `每 ${v} 秒`;
}

export type GroupForm = {
  name: string;
  description: string;
  qps: number;
  rpm: number;
  tpm: number;
  quota_requests: string;
  quota_tokens: string;
  quota_period_preset: string;
  quota_period_custom: string;
  period_quota_tokens: string;
  period_quota_requests: string;
  allowed_model_aliases: string[];
  allowed_channel_ids: number[];
  oidc_claim_expr: string;
  oidc_claim_priority: string;
  is_default: boolean;
  enabled: boolean;
};

export const initialForm: GroupForm = {
  name: "",
  description: "",
  qps: -1,
  rpm: -1,
  tpm: -1,
  quota_requests: "",
  quota_tokens: "",
  quota_period_preset: "",
  quota_period_custom: "",
  period_quota_tokens: "",
  period_quota_requests: "",
  allowed_model_aliases: [],
  allowed_channel_ids: [],
  oidc_claim_expr: "",
  oidc_claim_priority: "0",
  is_default: false,
  enabled: true,
};

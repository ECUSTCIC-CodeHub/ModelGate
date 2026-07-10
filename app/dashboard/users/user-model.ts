export type UserRow = {
  id: number;
  username: string;
  email: string | null;
  note: string | null;
  role: "admin" | "user";
  group_id: number | null;
  group_name: string | null;
  enabled: number;
  rpm: number;
  qps: number;
  tpm: number;
  quota_tokens: number | null;
  quota_requests: number | null;
  quota_period: number | null;
  period_quota_tokens: number | null;
  period_quota_requests: number | null;
  period_used_tokens: number;
  period_used_requests: number;
  period_reset_at: string | null;
  used_tokens: number;
  used_requests: number;
  allowed_model_aliases: string[];
  oidc_issuer: string | null;
  oidc_subject: string | null;
  totp_enabled: number;
  group_locked: number;
  group_rpm: number | null;
  group_qps: number | null;
  group_tpm: number | null;
  group_quota_requests: number | null;
  group_quota_tokens: number | null;
  group_quota_period: number | null;
  group_period_quota_tokens: number | null;
  group_period_quota_requests: number | null;
  effective_rpm: number;
  effective_qps: number;
  effective_tpm: number;
  effective_quota_requests: number | null;
  effective_quota_tokens: number | null;
  effective_quota_period: number | null;
  effective_period_quota_tokens: number | null;
  effective_period_quota_requests: number | null;
};

export type AliasOption = {
  id: number;
  alias: string;
  is_public: number;
};

export type GroupOption = {
  id: number;
  name: string;
  is_default: number;
};

export type UserOidcBinding = {
  issuer: string;
  subject: string;
};

export type UserGroupLimits = {
  rpm: number | null;
  qps: number | null;
  tpm: number | null;
  quota_requests: number | null;
  quota_tokens: number | null;
  quota_period: number | null;
  period_quota_tokens: number | null;
  period_quota_requests: number | null;
};

export type UserSortKey = "created_at" | "used_requests" | "used_tokens" | "username";

export const PERIOD_PRESETS = [
  { label: "不限制（继承组）", value: "" },
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
  if (v === 3600) return "每小时";
  if (v === 86400) return "每日";
  if (v === 604800) return "每周";
  if (v === 2592000) return "每月";
  if (v >= 86400) return `每 ${Math.round(v / 86400)} 天`;
  if (v >= 3600) return `每 ${Math.round(v / 3600)} 小时`;
  return `每 ${v} 秒`;
}

export type UserForm = {
  username: string;
  email: string;
  password: string;
  new_password: string;
  role: "admin" | "user";
  group_id: string;
  enabled: boolean;
  group_locked: boolean;
  rpm: number;
  qps: number;
  tpm: number;
  quota_tokens: string;
  quota_requests: string;
  quota_period_preset: string;
  quota_period_custom: string;
  period_quota_tokens: string;
  period_quota_requests: string;
  allowed_model_aliases: string[];
  note: string;
};

export const initialForm: UserForm = {
  username: "",
  email: "",
  password: "",
  new_password: "",
  role: "user",
  group_id: "",
  enabled: true,
  group_locked: false,
  rpm: -1,
  qps: -1,
  tpm: -1,
  quota_tokens: "",
  quota_requests: "",
  quota_period_preset: "",
  quota_period_custom: "",
  period_quota_tokens: "",
  period_quota_requests: "",
  allowed_model_aliases: [],
  note: "",
};

import type { PeriodCycleDraft } from "@/app/dashboard/period-cycle-fields";
import type { PeriodQuotaEntry } from "@/lib/gateway/quota";

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
  period_cycles: string | null;
  used_tokens: number;
  used_requests: number;
  allowed_model_aliases: string[];
  oidc_issuer: string | null;
  oidc_subject: string | null;
  group_locked: number;
  group_rpm: number | null;
  group_qps: number | null;
  group_tpm: number | null;
  group_quota_requests: number | null;
  group_quota_tokens: number | null;
  group_period_cycles: string | null;
  effective_rpm: number;
  effective_qps: number;
  effective_tpm: number;
  effective_quota_requests: number | null;
  effective_quota_tokens: number | null;
  periods?: PeriodQuotaEntry[];
};

export type AliasOption = {
  id: number;
  alias: string;
  is_public: number;
  enabled: number;
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
  period_cycles: string | null;
};

export type UserSortKey = "created_at" | "used_requests" | "used_tokens" | "username";

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
  period_cycles: PeriodCycleDraft[];
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
  period_cycles: [],
  allowed_model_aliases: [],
  note: "",
};

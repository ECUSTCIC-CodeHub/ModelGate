export type Role = "admin" | "user";

export type QuotaData = {
  total: {
    quota_requests: number | null;
    quota_tokens: number | null;
    used_requests: number;
    used_tokens: number;
    remaining_requests: number | null;
    remaining_tokens: number | null;
  };
  period: {
    period_seconds: number;
    period_label: string;
    quota_requests: number | null;
    quota_tokens: number | null;
    used_requests: number;
    used_tokens: number;
    remaining_requests: number | null;
    remaining_tokens: number | null;
    reset_at: string | null;
  } | null;
  rate: {
    rpm: number;
    qps: number;
    tpm: number;
  };
};

export type Summary = {
  total_requests: number;
  total_tokens: number;
  failed_requests: number;
  total_keys: number;
  active_users: number;
  avg_latency_ms: number;
  avg_output_tps: number;
  retry_requests: number;
  rate_limited_requests: number;
  success_rate: number;
  estimated_peak_concurrency: number;
  estimated_avg_concurrency: number;
  hourly_tokens: Array<{ hour: string; tokens: number }>;
  top_models: Array<{ model_name: string; request_count: number; total_tokens: number }>;
  top_channels: Array<{ channel_name: string; request_count: number; total_tokens: number }>;
};

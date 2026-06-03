export type LogRole = "admin" | "user";

export type LogTokenUsageTotals = {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  text_tokens?: number | null;
  reasoning_tokens?: number | null;
  total_tokens: number | null;
  cache?: {
    read_tokens?: number | null;
    creation_tokens?: number | null;
    miss_tokens?: number | null;
  } | null;
};

export type LogMetadata = {
  token_usage?: {
    remote?: LogTokenUsageTotals | null;
    local?: LogTokenUsageTotals | null;
  };
} | null;

export type LogRow = {
  id: number;
  username: string;
  channel_name: string | null;
  key_id: number | null;
  key_name: string | null;
  key_masked: string | null;
  model_alias: string | null;
  real_model: string | null;
  stream: number;
  status_code: number;
  error_message: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  token_source: "usage" | "local" | "estimated" | string | null;
  metadata: LogMetadata;
  latency_ms: number | null;
  first_token_latency_ms: number | null;
  output_tps: number | null;
  route_attempts: number | null;
  attempted_channels: string | null;
  client_ip: string | null;
  user_agent: string | null;
  created_at: string;
};

export type LogSummary = {
  total_requests: number;
  failed_requests: number;
  total_tokens: number;
  avg_latency_ms: number;
  avg_first_token_latency_ms: number;
  avg_output_tps: number;
};

export type LogStatusFilter = "all" | "success" | "failed";

export type LogFilters = {
  user: string;
  model: string;
  channel: string;
  key: string;
  ip: string;
  startDate: string;
  endDate: string;
  status: LogStatusFilter;
};

export const emptyLogFilters: LogFilters = {
  user: "",
  model: "",
  channel: "",
  key: "",
  ip: "",
  startDate: "",
  endDate: "",
  status: "all",
};

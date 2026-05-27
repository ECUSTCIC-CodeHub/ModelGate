export type LogRole = "admin" | "user";

export type LogRow = {
  id: number;
  username: string;
  channel_name: string | null;
  model_alias: string | null;
  real_model: string | null;
  stream: number;
  status_code: number;
  error_message: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
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

export type LogFilters = {
  user: string;
  model: string;
  channel: string;
  ip: string;
  startDate: string;
  endDate: string;
};

export const emptyLogFilters: LogFilters = {
  user: "",
  model: "",
  channel: "",
  ip: "",
  startDate: "",
  endDate: "",
};

import { gatewayDb } from "@/lib/core/db";

export type CreateLogInput = {
  user_id: number;
  key_id: number;
  channel_id: number | null;
  model_alias: string | null;
  real_model: string | null;
  stream: boolean;
  status_code: number;
  estimated_tokens: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  token_source?: string | null;
  metadata?: unknown;
  latency_ms: number;
  first_token_latency_ms?: number | null;
  output_tps?: number | null;
  route_attempts?: number | null;
  attempted_channels?: string | null;
  error_message?: string | null;
  client_ip?: string | null;
  user_agent?: string | null;
};

function serializeMetadata(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export async function createLog(input: CreateLogInput) {
  await gatewayDb.execute(
    `INSERT INTO logs (
         user_id, key_id, channel_id, model_alias, real_model,
         stream, status_code, estimated_tokens, prompt_tokens, completion_tokens, total_tokens,
         token_source, metadata, latency_ms, first_token_latency_ms, output_tps, route_attempts, attempted_channels, error_message, client_ip, user_agent
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.user_id,
      input.key_id,
      input.channel_id,
      input.model_alias,
      input.real_model,
      input.stream ? 1 : 0,
      input.status_code,
      input.estimated_tokens,
      input.prompt_tokens ?? null,
      input.completion_tokens ?? null,
      input.total_tokens ?? null,
      input.token_source ?? null,
      serializeMetadata(input.metadata),
      input.latency_ms,
      input.first_token_latency_ms ?? null,
      input.output_tps ?? null,
      input.route_attempts ?? 1,
      input.attempted_channels ?? null,
      input.error_message ?? null,
      input.client_ip ?? null,
      input.user_agent ?? null,
    ],
  );
}

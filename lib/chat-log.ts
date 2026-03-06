import { gatewayDb } from "@/lib/db";

type ChatLogInput = {
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
  latency_ms: number;
  first_token_latency_ms?: number | null;
  output_tps?: number | null;
  error_message?: string | null;
  request_body?: unknown;
  response_body?: unknown;
};

function safeStringify(value: unknown, maxLength = 2000) {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) return null;
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  } catch {
    return null;
  }
}

export function insertChatLog(input: ChatLogInput) {
  gatewayDb
    .prepare(
      `INSERT INTO chat_logs (
         user_id, key_id, channel_id, model_alias, real_model,
         stream, status_code, estimated_tokens, prompt_tokens, completion_tokens, total_tokens,
         latency_ms, first_token_latency_ms, output_tps, error_message, request_body, response_body
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
      input.latency_ms,
      input.first_token_latency_ms ?? null,
      input.output_tps ?? null,
      input.error_message ?? null,
      safeStringify(input.request_body),
      safeStringify(input.response_body),
    );
}

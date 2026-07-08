import { createLog, type CreateLogInput } from "@/lib/data/repositories/log-repository";
import { getJsonlLogWriter } from "@/lib/gateway/jsonl-log-writer";

export type ChatLogInput = CreateLogInput;

function extractCacheTokens(metadataValue: unknown): { read: number; creation: number } {
  try {
    if (metadataValue && typeof metadataValue === "object" && !Array.isArray(metadataValue)) {
      const meta = metadataValue as Record<string, unknown>;
      const usage = meta.token_usage && typeof meta.token_usage === "object" ? meta.token_usage as Record<string, unknown> : null;
      const remote = usage?.remote && typeof usage.remote === "object" ? usage.remote as Record<string, unknown> : null;
      const cache = remote?.cache && typeof remote.cache === "object" ? remote.cache as Record<string, unknown> : null;
      return {
        read: typeof cache?.read_tokens === "number" ? cache.read_tokens : 0,
        creation: typeof cache?.creation_tokens === "number" ? cache.creation_tokens : 0,
      };
    }
  } catch {
    // metadata parse error, ignore
  }
  return { read: 0, creation: 0 };
}

function buildJsonlRecord(input: ChatLogInput): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    user_id: input.user_id,
    key_id: input.key_id,
    channel_id: input.channel_id ?? null,
    model_alias: input.model_alias ?? null,
    real_model: input.real_model ?? null,
    stream: input.stream,
    status_code: input.status_code,
    estimated_tokens: input.estimated_tokens,
    prompt_tokens: input.prompt_tokens,
    completion_tokens: input.completion_tokens,
    total_tokens: input.total_tokens,
    token_source: input.token_source ?? null,
    metadata: input.metadata ?? null,
    latency_ms: input.latency_ms,
    first_token_latency_ms: input.first_token_latency_ms ?? null,
    output_tps: input.output_tps,
    route_attempts: input.route_attempts ?? 1,
    attempted_channels: input.attempted_channels ?? null,
    error_message: input.error_message ?? null,
    client_ip: input.client_ip ?? null,
    user_agent: input.user_agent ?? null,
  };
}

export async function insertChatLog(input: ChatLogInput) {
  const cache = input.metadata ? extractCacheTokens(input.metadata) : { read: 0, creation: 0 };
  const cacheTokens = cache.read + cache.creation;
  if (cacheTokens > 0 && input.prompt_tokens !== null) {
    await createLog({
      ...input,
      prompt_tokens: input.prompt_tokens + cacheTokens,
      total_tokens: (input.total_tokens ?? 0) + cacheTokens,
    });
  } else {
    await createLog(input);
  }

  const writer = getJsonlLogWriter();
  if (writer) {
    writer.enqueue(buildJsonlRecord(input)).catch(() => {
      // JSONL write failure is non-critical
    });
  }
}

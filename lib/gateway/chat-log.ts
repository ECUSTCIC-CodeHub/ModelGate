import { createLog, type CreateLogInput } from "@/lib/data/repositories/log-repository";

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
    skipped_channels: input.skipped_channels ?? null,
    error_message: input.error_message ?? null,
    client_ip: input.client_ip ?? null,
    user_agent: input.user_agent ?? null,
  };
}

async function getWriter() {
  try {
    const mod = await import("@/lib/gateway/jsonl-log-writer");
    return mod.getJsonlLogWriter();
  } catch {
    return null;
  }
}

export function withSubstitutionNote(metadata: unknown, note: string | null | undefined): Record<string, unknown> | null {
  if (!note) {
    return metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : null;
  }
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
  return { ...base, substitution_reason: note };
}

// 全部 22 处调用点都是 fire-and-forget（不 await、不 catch）：响应已经返回，
// 日志落库失败不该影响请求结果。但 Node 对未处理的 rejection 默认终止进程，
// 因此错误必须在这里就地收口，且要限频记录——数据库故障时每个请求都会失败。
const LOG_FAILURE_INTERVAL_MS = 10_000;
let lastFailureLoggedAt = 0;
let suppressedFailures = 0;

// 日志里会拼进模型别名和数据库错误原文，两者都可能带用户可控内容
// （如 Duplicate entry 会回显具体值）。压掉换行等控制字符，
// 避免一条失败日志被撑成多行、伪造出并不存在的日志行。
// user_id / key_id 是数值主键，无控制字符面，直接插值。
function summarizeForLog(value: unknown, maxLength = 200): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const flattened = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength)}...` : flattened;
}

function logWriteFailure(input: ChatLogInput, error: unknown) {
  const now = Date.now();
  if (now - lastFailureLoggedAt < LOG_FAILURE_INTERVAL_MS) {
    suppressedFailures += 1;
    return;
  }
  const folded = suppressedFailures;
  suppressedFailures = 0;
  lastFailureLoggedAt = now;
  const suffix = folded > 0 ? `（另有 ${folded} 次同类失败被折叠）` : "";
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[log] 请求日志写入失败 user=${input.user_id} key=${input.key_id} model=${summarizeForLog(input.model_alias ?? "-", 64)}${suffix} - ${name}: ${summarizeForLog(message)}`,
  );
}

export async function insertChatLog(input: ChatLogInput) {
  try {
    await writeChatLog(input);
  } catch (error) {
    logWriteFailure(input, error);
  }
}

async function writeChatLog(input: ChatLogInput) {
  const cache = input.metadata ? extractCacheTokens(input.metadata) : { read: 0, creation: 0 };
  const cacheTokens = cache.read + cache.creation;
  if (cacheTokens > 0 && input.prompt_tokens != null) {
    await createLog({
      ...input,
      prompt_tokens: (input.prompt_tokens ?? 0) + cacheTokens,
      total_tokens: (input.total_tokens ?? 0) + cacheTokens,
    });
  } else {
    await createLog(input);
  }

  const writer = await getWriter();
  if (writer) {
    writer.enqueue(buildJsonlRecord(input)).catch(() => {
      // JSONL write failure is non-critical
    });
  }
}


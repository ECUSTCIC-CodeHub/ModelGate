import { createSseFrameReader } from "@/lib/shared/sse-frames";

export type ToolCallState = {
  index: number;
  id: string;
  name: string;
  arguments: string;
};

export type StreamUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  text_tokens?: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cache_miss_tokens?: number;
};

export type IntermediateStreamEvent =
  | { type: "start"; id?: string; model?: string | null; created?: number; usage?: StreamUsage | null }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "reasoning_signature"; signature: string }
  | { type: "tool_call_start"; index: number; id: string; name: string; arguments?: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments: string }
  | { type: "usage"; usage: StreamUsage }
  | { type: "finish"; reason: string | null };

export type IntermediateStreamResult = {
  stream: ReadableStream<IntermediateStreamEvent>;
  completionText: () => string;
  reasoningText: () => string;
  firstTokenAt: () => number | null;
  usage: () => StreamUsage | null;
};

export function toSseBlock(event: string | null, data: unknown) {
  const lines: string[] = [];
  if (event) lines.push(`event: ${event}`);
  const json = typeof data === "string" ? data : JSON.stringify(data);
  for (const line of json.split("\n")) {
    lines.push(`data: ${line}`);
  }
  return `${lines.join("\n")}\n\n`;
}

// HTTP 状态码在流开始时已经发出，流中途的上游错误只能靠协议内错误事件告知调用方，
// 否则客户端只会看到连接中断，拿不到真实原因
export function errorMessageFrom(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "上游流式请求失败";
}

export type StreamTransformResult = {
  stream: ReadableStream<Uint8Array>;
  completionText: () => string;
  reasoningText: () => string;
  firstTokenAt: () => number | null;
  usage: () => StreamUsage | null;
};

export type PassthroughEventTracker = (event: string, data: string) => {
  completionText?: string;
  reasoningText?: string;
  firstToken?: boolean;
  usage?: Partial<StreamUsage>;
} | null;

function normalizeTokenCount(value: unknown, fallback: number) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.round(count)) : fallback;
}

function mergeUsage(current: StreamUsage | null, next: Partial<StreamUsage>) {
  const promptTokens = next.prompt_tokens !== undefined
    ? normalizeTokenCount(next.prompt_tokens, current?.prompt_tokens ?? 0)
    : current?.prompt_tokens ?? 0;
  const completionTokens = next.completion_tokens !== undefined
    ? normalizeTokenCount(next.completion_tokens, current?.completion_tokens ?? 0)
    : current?.completion_tokens ?? 0;
  const totalTokens = next.total_tokens !== undefined
    ? normalizeTokenCount(next.total_tokens, promptTokens + completionTokens)
    : promptTokens + completionTokens;
  const textTokens = next.text_tokens !== undefined
    ? normalizeTokenCount(next.text_tokens, current?.text_tokens ?? 0)
    : current?.text_tokens;
  const reasoningTokens = next.reasoning_tokens !== undefined
    ? normalizeTokenCount(next.reasoning_tokens, current?.reasoning_tokens ?? 0)
    : current?.reasoning_tokens;
  const cacheReadTokens = next.cache_read_tokens !== undefined
    ? normalizeTokenCount(next.cache_read_tokens, current?.cache_read_tokens ?? 0)
    : current?.cache_read_tokens;
  const cacheCreationTokens = next.cache_creation_tokens !== undefined
    ? normalizeTokenCount(next.cache_creation_tokens, current?.cache_creation_tokens ?? 0)
    : current?.cache_creation_tokens;
  const cacheMissTokens = next.cache_miss_tokens !== undefined
    ? normalizeTokenCount(next.cache_miss_tokens, current?.cache_miss_tokens ?? 0)
    : current?.cache_miss_tokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(textTokens !== undefined ? { text_tokens: textTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoning_tokens: reasoningTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cache_read_tokens: cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cache_creation_tokens: cacheCreationTokens } : {}),
    ...(cacheMissTokens !== undefined ? { cache_miss_tokens: cacheMissTokens } : {}),
  };
}

export function createPassthroughStream(
  upstream: ReadableStream<Uint8Array>,
  trackEvent: PassthroughEventTracker,
): StreamTransformResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const frameReader = createSseFrameReader();
  let completionText = "";
  let reasoningText = "";
  let firstTokenAt: number | null = null;
  let usage: StreamUsage | null = null;
  const markFirstToken = () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          controller.enqueue(value);
          for (const frame of frameReader.push(decoder.decode(value, { stream: true }))) {
            if (!frame.hasData) continue;
            if (frame.data === "[DONE]") continue;

            try {
              const tracked = trackEvent(frame.event, frame.data);
              if (tracked?.usage) {
                usage = mergeUsage(usage, tracked.usage);
              }
              if (tracked?.completionText) {
                markFirstToken();
                completionText += tracked.completionText;
              }
              if (tracked?.reasoningText) {
                markFirstToken();
                reasoningText += tracked.reasoningText;
              } else if (tracked?.firstToken) {
                markFirstToken();
              }
            } catch {
              // Ignore malformed event for metrics capture only.
            }
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return {
    stream,
    completionText: () => completionText,
    reasoningText: () => reasoningText,
    firstTokenAt: () => firstTokenAt,
    usage: () => usage,
  };
}

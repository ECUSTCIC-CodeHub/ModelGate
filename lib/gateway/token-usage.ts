import type { IntermediateUsage } from "@/lib/gateway/protocol-adapters/intermediate";
import { countTextTokens } from "@/lib/gateway/tokenizer";

export type TokenUsageSource = "usage" | "local" | "estimated";

export type ResolvedTokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: TokenUsageSource;
  remotePromptTokens: number | null;
  remoteCompletionTokens: number | null;
  remoteTotalTokens: number | null;
  localPromptTokens: number;
  localCompletionTokens: number;
  localTotalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheMissTokens: number;
};

function normalizeTokenCount(value: unknown, fallback: number) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.round(count)) : fallback;
}

export function resolveTokenUsage(options: {
  usage: IntermediateUsage | null | undefined;
  localPromptTokens: number;
  completionText: string;
  model: string;
}): ResolvedTokenUsage {
  const localCompletionTokens = Math.max(0, countTextTokens(options.completionText, options.model));
  const localTotalTokens = options.localPromptTokens + localCompletionTokens;

  if (options.usage) {
    const promptTokens = normalizeTokenCount(options.usage.prompt_tokens, options.localPromptTokens);
    const completionTokens = normalizeTokenCount(options.usage.completion_tokens, 0);
    const totalTokens = normalizeTokenCount(options.usage.total_tokens, promptTokens + completionTokens);
    return {
      promptTokens,
      completionTokens,
      totalTokens,
      source: "usage",
      remotePromptTokens: promptTokens,
      remoteCompletionTokens: completionTokens,
      remoteTotalTokens: totalTokens,
      localPromptTokens: options.localPromptTokens,
      localCompletionTokens,
      localTotalTokens,
      cacheReadTokens: normalizeTokenCount(options.usage.cache_read_tokens, 0),
      cacheCreationTokens: normalizeTokenCount(options.usage.cache_creation_tokens, 0),
      cacheMissTokens: normalizeTokenCount(options.usage.cache_miss_tokens, 0),
    };
  }

  return {
    promptTokens: options.localPromptTokens,
    completionTokens: localCompletionTokens,
    totalTokens: localTotalTokens,
    source: "local",
    remotePromptTokens: null,
    remoteCompletionTokens: null,
    remoteTotalTokens: null,
    localPromptTokens: options.localPromptTokens,
    localCompletionTokens,
    localTotalTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheMissTokens: 0,
  };
}

export function tokenUsageMetadata(usage: ResolvedTokenUsage) {
  return {
    token_usage: {
      remote: usage.remotePromptTokens === null
        ? null
        : {
            prompt_tokens: usage.remotePromptTokens,
            completion_tokens: usage.remoteCompletionTokens,
            total_tokens: usage.remoteTotalTokens,
          },
      local: {
        prompt_tokens: usage.localPromptTokens,
        completion_tokens: usage.localCompletionTokens,
        total_tokens: usage.localTotalTokens,
      },
      cache: {
        read_tokens: usage.cacheReadTokens,
        creation_tokens: usage.cacheCreationTokens,
        miss_tokens: usage.cacheMissTokens,
      },
    },
  };
}

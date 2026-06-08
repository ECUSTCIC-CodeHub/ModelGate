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
  remoteTextTokens: number | null;
  remoteTotalTokens: number | null;
  remoteReasoningTokens: number | null;
  localPromptTokens: number;
  localCompletionTokens: number;
  localReasoningTokens: number;
  localTotalTokens: number;
  reasoningTokens: number;
  outputTpsTokens: number;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  cacheMissTokens: number | null;
};

function normalizeTokenCount(value: unknown, fallback: number) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.round(count)) : fallback;
}

export function resolveTokenUsage(options: {
  usage: IntermediateUsage | null | undefined;
  localPromptTokens: number;
  completionText: string;
  reasoningText?: string;
  model: string;
}): ResolvedTokenUsage {
  const localCompletionTokens = Math.max(0, countTextTokens(options.completionText, options.model));
  const localReasoningTokens = Math.max(0, countTextTokens(options.reasoningText ?? "", options.model));
  const localTotalTokens = options.localPromptTokens + localCompletionTokens + localReasoningTokens;

  if (options.usage) {
    const promptTokens = normalizeTokenCount(options.usage.prompt_tokens, options.localPromptTokens);
    const remoteCompletionTokens = normalizeTokenCount(options.usage.completion_tokens, 0);
    const totalTokens = Math.max(
      normalizeTokenCount(options.usage.total_tokens, promptTokens + remoteCompletionTokens),
      promptTokens + remoteCompletionTokens,
    );
    const remoteReasoningTokens = options.usage.reasoning_tokens === undefined
      ? null
      : normalizeTokenCount(options.usage.reasoning_tokens, 0);
    const reasoningTokens = remoteReasoningTokens ?? localReasoningTokens;
    const remoteTextTokens = options.usage.text_tokens === undefined
      ? null
      : normalizeTokenCount(options.usage.text_tokens, 0);
    const completionTokens = remoteTextTokens ?? (localReasoningTokens > 0 && remoteReasoningTokens === null
      ? localCompletionTokens
      : reasoningTokens > 0
        ? Math.max(0, remoteCompletionTokens - reasoningTokens)
        : remoteCompletionTokens);
    return {
      promptTokens,
      completionTokens,
      totalTokens,
      source: "usage",
      remotePromptTokens: promptTokens,
      remoteCompletionTokens,
      remoteTextTokens,
      remoteTotalTokens: totalTokens,
      remoteReasoningTokens,
      localPromptTokens: options.localPromptTokens,
      localCompletionTokens,
      localReasoningTokens,
      localTotalTokens,
      reasoningTokens,
      outputTpsTokens: completionTokens + reasoningTokens,
      cacheReadTokens: options.usage.cache_read_tokens === undefined
        ? null
        : normalizeTokenCount(options.usage.cache_read_tokens, 0),
      cacheCreationTokens: options.usage.cache_creation_tokens === undefined
        ? null
        : normalizeTokenCount(options.usage.cache_creation_tokens, 0),
      cacheMissTokens: options.usage.cache_miss_tokens === undefined
        ? null
        : normalizeTokenCount(options.usage.cache_miss_tokens, 0),
    };
  }

  return {
    promptTokens: options.localPromptTokens,
    completionTokens: localCompletionTokens,
    totalTokens: localTotalTokens,
    source: "local",
    remotePromptTokens: null,
    remoteCompletionTokens: null,
    remoteTextTokens: null,
    remoteTotalTokens: null,
    remoteReasoningTokens: null,
    localPromptTokens: options.localPromptTokens,
    localCompletionTokens,
    localReasoningTokens,
    localTotalTokens,
    reasoningTokens: localReasoningTokens,
    outputTpsTokens: localCompletionTokens + localReasoningTokens,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    cacheMissTokens: null,
  };
}

export function tokenUsageMetadata(usage: ResolvedTokenUsage) {
  const cacheUsage = {
    ...(usage.cacheReadTokens !== null ? { read_tokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheCreationTokens !== null ? { creation_tokens: usage.cacheCreationTokens } : {}),
    ...(usage.cacheMissTokens !== null ? { miss_tokens: usage.cacheMissTokens } : {}),
  };
  const hasCacheUsage = Object.keys(cacheUsage).length > 0;

  return {
    token_usage: {
      remote: usage.remotePromptTokens === null
        ? null
        : {
            prompt_tokens: usage.remotePromptTokens,
            completion_tokens: usage.remoteCompletionTokens,
            total_tokens: usage.remoteTotalTokens,
            ...(usage.remoteTextTokens !== null ? { text_tokens: usage.remoteTextTokens } : {}),
            ...(usage.remoteReasoningTokens !== null ? { reasoning_tokens: usage.remoteReasoningTokens } : {}),
            ...(hasCacheUsage ? { cache: cacheUsage } : {}),
          },
      local: {
        prompt_tokens: usage.localPromptTokens,
        completion_tokens: usage.localCompletionTokens,
        reasoning_tokens: usage.localReasoningTokens,
        total_tokens: usage.localTotalTokens,
      },
    },
  };
}

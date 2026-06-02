import type { IntermediateUsage } from "@/lib/gateway/protocol-adapters/intermediate";
import { countTextTokens } from "@/lib/gateway/tokenizer";

export type TokenUsageSource = "usage" | "local" | "estimated";

export type ResolvedTokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: TokenUsageSource;
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
  if (options.usage) {
    const promptTokens = normalizeTokenCount(options.usage.prompt_tokens, options.localPromptTokens);
    const completionTokens = normalizeTokenCount(options.usage.completion_tokens, 0);
    const totalTokens = normalizeTokenCount(options.usage.total_tokens, promptTokens + completionTokens);
    return {
      promptTokens,
      completionTokens,
      totalTokens,
      source: "usage",
    };
  }

  const completionTokens = Math.max(0, countTextTokens(options.completionText, options.model));
  return {
    promptTokens: options.localPromptTokens,
    completionTokens,
    totalTokens: options.localPromptTokens + completionTokens,
    source: "local",
  };
}

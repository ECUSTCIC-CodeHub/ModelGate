import { asRecord } from "@/lib/gateway/normalized-message";
import { normalizeUsage, type IntermediateUsage } from "@/lib/gateway/protocol-adapters/intermediate";

type UsageFieldSet = {
  promptTokens: unknown;
  completionTokens: unknown;
  totalTokens: unknown;
};

function tokenCount(value: unknown, fallback = 0) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.round(count)) : fallback;
}

function sumTokenFields(record: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!record) return 0;
  return keys.reduce((total, key) => total + tokenCount(record[key], 0), 0);
}

function hasTokenField(record: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!record) return false;
  return keys.some((key) => Number.isFinite(Number(record[key])));
}

function sumNestedTokenFields(record: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!record) return 0;
  return keys.reduce((total, key) => {
    const nested = asRecord(record[key]);
    return total + (nested ? sumTokenFields(nested, Object.keys(nested)) : 0);
  }, 0);
}

function hasNestedTokenField(record: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!record) return false;
  return keys.some((key) => {
    const nested = asRecord(record[key]);
    return nested ? Object.values(nested).some((value) => Number.isFinite(Number(value))) : false;
  });
}

function normalizeRemoteUsage(usage: Record<string, unknown>, fields: UsageFieldSet): IntermediateUsage {
  const promptTokens = tokenCount(fields.promptTokens);
  const completionTokens = tokenCount(fields.completionTokens);
  const totalTokens = tokenCount(fields.totalTokens, promptTokens + completionTokens);
  const promptDetails = asRecord(usage.prompt_tokens_details) ?? asRecord(usage.input_tokens_details);

  const cacheReadKeys = [
    "cached_tokens",
    "cache_read_tokens",
    "cache_read_input_tokens",
    "prompt_cache_hit_tokens",
    "cachedContentTokenCount",
  ];
  const cacheCreationKeys = [
    "cache_creation_tokens",
    "cache_creation_input_tokens",
    "prompt_cache_creation_tokens",
  ];
  const cacheMissKeys = [
    "cache_miss_tokens",
    "cache_miss_input_tokens",
    "prompt_cache_miss_tokens",
  ];

  const hasCacheReadTokens = hasTokenField(usage, cacheReadKeys) || hasTokenField(promptDetails, cacheReadKeys);
  const hasCacheCreationTokens =
    hasTokenField(usage, cacheCreationKeys) ||
    hasTokenField(promptDetails, cacheCreationKeys) ||
    hasNestedTokenField(usage, ["cache_creation"]) ||
    hasNestedTokenField(promptDetails, ["cache_creation"]);
  const hasCacheMissTokens = hasTokenField(usage, cacheMissKeys) || hasTokenField(promptDetails, cacheMissKeys);

  const cacheReadTokens =
    sumTokenFields(usage, [
      "cached_tokens",
      "cache_read_tokens",
      "cache_read_input_tokens",
      "prompt_cache_hit_tokens",
      "cachedContentTokenCount",
    ]) +
    sumTokenFields(promptDetails, [
      "cached_tokens",
      "cache_read_tokens",
      "cache_read_input_tokens",
      "prompt_cache_hit_tokens",
      "cachedContentTokenCount",
    ]);

  const cacheCreationTokens =
    sumTokenFields(usage, [
      "cache_creation_tokens",
      "cache_creation_input_tokens",
      "prompt_cache_creation_tokens",
    ]) +
    sumTokenFields(promptDetails, [
      "cache_creation_tokens",
      "cache_creation_input_tokens",
      "prompt_cache_creation_tokens",
    ]) +
    sumNestedTokenFields(usage, ["cache_creation"]) +
    sumNestedTokenFields(promptDetails, ["cache_creation"]);

  const cacheMissTokens =
    sumTokenFields(usage, [
      "cache_miss_tokens",
      "cache_miss_input_tokens",
      "prompt_cache_miss_tokens",
    ]) +
    sumTokenFields(promptDetails, [
      "cache_miss_tokens",
      "cache_miss_input_tokens",
      "prompt_cache_miss_tokens",
    ]);

  return normalizeUsage(promptTokens, completionTokens, totalTokens, {
    ...(hasCacheReadTokens ? { cache_read_tokens: cacheReadTokens } : {}),
    ...(hasCacheCreationTokens ? { cache_creation_tokens: cacheCreationTokens } : {}),
    ...(hasCacheMissTokens ? { cache_miss_tokens: cacheMissTokens } : {}),
  });
}

export function usageFromChatCompletions(value: unknown) {
  const usage = asRecord(value);
  if (!usage) return null;
  return normalizeRemoteUsage(usage, {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  });
}

export function usageFromResponses(value: unknown) {
  const usage = asRecord(value);
  if (!usage) return null;
  return normalizeRemoteUsage(usage, {
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  });
}

export function usageFromAnthropic(value: unknown) {
  const usage = asRecord(value);
  if (!usage) return null;
  return normalizeRemoteUsage(usage, {
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  });
}

import { normalizeToolCalls } from "@/lib/gateway/ollama-adapter/tool-calls";
import type { JsonRecord, Usage } from "@/lib/gateway/ollama-adapter/types";
import { asArray, asRecord } from "@/lib/gateway/ollama-adapter/utils";

function extractTextContent(value: unknown) {
  if (typeof value === "string") return value;
  return asArray(value)
    .map((item) => {
      const record = asRecord(item);
      return typeof record?.text === "string" ? record.text : "";
    })
    .join("");
}

function getUsage(parsed: JsonRecord): Usage {
  const usage = asRecord(parsed.usage);
  const promptTokens = Number(usage?.prompt_tokens ?? 0);
  const completionTokens = Number(usage?.completion_tokens ?? 0);
  const totalTokens = Number(usage?.total_tokens ?? promptTokens + completionTokens);
  return {
    prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completion_tokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0,
  };
}

function createdAtFromChatCompletion(parsed: JsonRecord) {
  const created = Number(parsed.created);
  if (Number.isFinite(created) && created > 0) {
    return new Date(created * 1000).toISOString();
  }
  return new Date().toISOString();
}

export function durationNs(startedAt: number) {
  return Math.max(0, Date.now() - startedAt) * 1_000_000;
}

function buildOllamaChatResponse(text: string, model: string, startedAt: number) {
  const parsed = JSON.parse(text) as JsonRecord;
  const firstChoice = asRecord(asArray(parsed.choices)[0]);
  const messageRecord = asRecord(firstChoice?.message);
  const usage = getUsage(parsed);
  const message: JsonRecord = {
    role: "assistant",
    content: extractTextContent(messageRecord?.content),
  };
  const reasoning = typeof messageRecord?.reasoning === "string"
    ? messageRecord.reasoning
    : typeof messageRecord?.reasoning_content === "string"
      ? messageRecord.reasoning_content
      : "";
  const toolCalls = normalizeToolCalls(messageRecord?.tool_calls);

  if (reasoning) message.thinking = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    model,
    created_at: createdAtFromChatCompletion(parsed),
    message,
    done: true,
    done_reason: typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : "stop",
    total_duration: durationNs(startedAt),
    load_duration: 0,
    prompt_eval_count: usage.prompt_tokens,
    prompt_eval_duration: 0,
    eval_count: usage.completion_tokens,
    eval_duration: 0,
  };
}

export function adaptChatCompletionToOllama(text: string, model: string, startedAt: number) {
  return JSON.stringify(buildOllamaChatResponse(text, model, startedAt));
}

export function adaptChatCompletionToOllamaStreamText(text: string, model: string, startedAt: number) {
  const response = buildOllamaChatResponse(text, model, startedAt);
  const { message, ...done } = response;
  return `${JSON.stringify({
    model: response.model,
    created_at: response.created_at,
    message,
    done: false,
  })}\n${JSON.stringify(done)}\n`;
}

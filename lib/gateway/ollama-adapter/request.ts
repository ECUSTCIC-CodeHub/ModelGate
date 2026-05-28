import type { JsonRecord } from "@/lib/gateway/ollama-adapter/types";
import { asArray, asRecord, isFiniteNumber } from "@/lib/gateway/ollama-adapter/utils";

function normalizeImageUrl(value: string) {
  if (/^(?:data:|https?:\/\/)/i.test(value)) return value;
  return `data:image/jpeg;base64,${value}`;
}

function normalizeMessageContent(message: JsonRecord) {
  const content = typeof message.content === "string" ? message.content : "";
  const images = asArray(message.images).filter((item): item is string => typeof item === "string" && item.length > 0);
  if (images.length === 0) return content;

  return [
    ...(content ? [{ type: "text", text: content }] : []),
    ...images.map((image) => ({
      type: "image_url",
      image_url: { url: normalizeImageUrl(image) },
    })),
  ];
}

function normalizeMessageThinking(message: JsonRecord) {
  return typeof message.thinking === "string"
    ? message.thinking
    : typeof message.reasoning === "string"
      ? message.reasoning
      : typeof message.reasoning_content === "string"
        ? message.reasoning_content
        : "";
}

function normalizeMessages(messages: unknown) {
  return asArray(messages)
    .map((item) => {
      const record = asRecord(item);
      if (!record) return null;
      const role = typeof record.role === "string" ? record.role : "user";
      const message: JsonRecord = {
        role,
        content: normalizeMessageContent(record),
      };
      const thinking = normalizeMessageThinking(record);
      if (role === "assistant" && thinking) message.reasoning = thinking;
      return message;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function normalizeResponseFormat(format: unknown) {
  if (format === "json") return { type: "json_object" };
  const schema = asRecord(format);
  if (!schema) return undefined;
  return {
    type: "json_schema",
    json_schema: {
      name: "response",
      schema,
    },
  };
}

export function isOllamaStreamRequested(body: JsonRecord) {
  return body.stream !== false;
}

export function adaptOllamaChatRequestBody(body: JsonRecord): JsonRecord {
  const options = asRecord(body.options) ?? {};
  const next: JsonRecord = {
    model: body.model,
    messages: normalizeMessages(body.messages),
    stream: isOllamaStreamRequested(body),
  };

  if (isFiniteNumber(options.temperature)) next.temperature = options.temperature;
  if (isFiniteNumber(options.top_p)) next.top_p = options.top_p;
  if (isFiniteNumber(options.seed)) next.seed = options.seed;
  if (options.stop !== undefined) next.stop = options.stop;
  if (body.tools !== undefined) next.tools = body.tools;

  const maxTokens = options.num_predict;
  if (isFiniteNumber(maxTokens) && maxTokens > 0) {
    next.max_tokens = maxTokens;
  }

  const responseFormat = normalizeResponseFormat(body.format);
  if (responseFormat) next.response_format = responseFormat;

  return next;
}

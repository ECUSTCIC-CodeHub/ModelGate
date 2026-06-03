import { asArray, asRecord, type JsonRecord } from "@/lib/gateway/normalized-message";
import { usageFromChatCompletions } from "@/lib/gateway/protocol-adapters/usage";

type ChatToolDelta = {
  index: number;
  id: string;
  name: string;
  arguments: string;
};

export function parseChatChunkEvent(data: string) {
  const parsed = JSON.parse(data) as JsonRecord;
  const choices = asArray(parsed.choices);
  const firstChoice = asRecord(choices[0]);
  const delta = asRecord(firstChoice?.delta);
  const toolCalls = asArray(delta?.tool_calls)
    .map((item) => {
      const record = asRecord(item);
      const fn = asRecord(record?.function);
      if (!record) return null;
      return {
        index: Number(record.index ?? 0),
        id: typeof record.id === "string" ? record.id : "",
        name: typeof fn?.name === "string" ? fn.name : "",
        arguments: typeof fn?.arguments === "string" ? fn.arguments : "",
      };
    })
    .filter((item): item is ChatToolDelta => Boolean(item));

  const usage = usageFromChatCompletions(parsed.usage);
  return {
    id: typeof parsed.id === "string" ? parsed.id : `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    model: typeof parsed.model === "string" ? parsed.model : null,
    created: Number(parsed.created ?? Math.floor(Date.now() / 1000)),
    content: typeof delta?.content === "string" ? delta.content : "",
    reasoning: typeof delta?.reasoning === "string"
      ? delta.reasoning
      : typeof delta?.reasoning_content === "string"
        ? delta.reasoning_content
        : "",
    toolCalls,
    finishReason: typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : null,
    usage,
  };
}

export function trackChatCompletionsStreamEvent(_event: string, data: string) {
  const parsed = parseChatChunkEvent(data);
  const tracked: {
    completionText?: string;
    firstToken?: boolean;
    usage?: NonNullable<typeof parsed.usage>;
  } = {};
  if (parsed.usage) tracked.usage = parsed.usage;
  if (parsed.content) tracked.completionText = parsed.content;
  if (parsed.reasoning) tracked.firstToken = true;
  return tracked.usage || tracked.completionText || tracked.firstToken ? tracked : null;
}

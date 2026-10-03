import type { GatewayProtocol } from "@/lib/gateway/protocols";

type JsonRecord = Record<string, unknown>;

export const MODEL_SYSTEM_PROMPT_MAX_LENGTH = 20000;

// 按上游协议把模型级系统提示词前置合并到已适配好的请求体。
// 返回新对象，不原地修改入参：重试切换渠道/模型后可以按新配置重新注入。
export function injectModelSystemPrompt(
  body: JsonRecord,
  protocol: GatewayProtocol,
  systemPrompt: string,
): JsonRecord {
  const prompt = systemPrompt.trim();
  // embeddings 与 other 没有 system 概念，注入无意义
  if (!prompt || protocol === "embeddings" || protocol === "other" || protocol === "images") {
    return body;
  }

  if (protocol === "chat_completions") return injectChatSystem(body, prompt);
  if (protocol === "responses") return injectResponsesInstructions(body, prompt);
  if (protocol === "anthropic_messages") return injectAnthropicSystem(body, prompt);
  return body;
}

function injectChatSystem(body: JsonRecord, prompt: string): JsonRecord {
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  const firstIndex = messages.findIndex(
    (message) => message && typeof message === "object" && (message as JsonRecord).role === "system",
  );

  if (firstIndex === -1) {
    return { ...body, messages: [{ role: "system", content: prompt }, ...messages] };
  }

  const first = messages[firstIndex] as JsonRecord;
  // 只有纯文本 system 消息才能安全前置拼接：数组形态无法在不丢结构的前提下合并
  if (typeof first.content === "string") {
    messages[firstIndex] = {
      ...first,
      content: first.content ? `${prompt}\n\n${first.content}` : prompt,
    };
    return { ...body, messages };
  }

  return { ...body, messages: [{ role: "system", content: prompt }, ...messages] };
}

function injectResponsesInstructions(body: JsonRecord, prompt: string): JsonRecord {
  const existing = body.instructions;
  // 只合并字符串形态：数组/对象形态的 instructions 无法可靠前置拼接，
  // 覆盖会丢掉客户端原有内容，因此保持原样不动
  if (typeof existing === "string") {
    return { ...body, instructions: existing ? `${prompt}\n\n${existing}` : prompt };
  }
  if (existing === undefined || existing === null) {
    return { ...body, instructions: prompt };
  }
  return body;
}

function injectAnthropicSystem(body: JsonRecord, prompt: string): JsonRecord {
  const existing = body.system;

  if (existing === undefined || existing === null) {
    return { ...body, system: prompt };
  }

  if (typeof existing === "string") {
    return { ...body, system: existing ? `${prompt}\n\n${existing}` : prompt };
  }

  // blocks 形态前插一个纯文本块，保留原有块的 cache_control 等标注
  if (Array.isArray(existing)) {
    return { ...body, system: [{ type: "text", text: prompt }, ...existing] };
  }

  return body;
}

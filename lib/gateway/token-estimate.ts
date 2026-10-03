type ChatMessage = {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
};

export function estimateRequestTokens(body: Record<string, unknown>) {
  const messages = (body.messages as ChatMessage[] | undefined) ?? [];
  const text = messages
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .map((p) => (typeof p.text === "string" ? p.text : ""))
          .join(" ");
      }
      return "";
    })
    .join("\n");

  const inputTokens = Math.ceil(text.length / 4);
  // max_completion_tokens 是 max_tokens 的替代名，只认其中一个会退化成默认预留值
  const requested = body.max_tokens ?? body.max_completion_tokens;
  const maxTokens = Number(requested ?? 256);
  const outputReserve = Number.isFinite(maxTokens) ? Math.max(0, maxTokens) : 256;
  return Math.max(1, inputTokens + Math.min(outputReserve, 4096));
}

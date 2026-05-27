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
};

export type IntermediateStreamEvent =
  | { type: "start"; id?: string; model?: string | null; created?: number; usage?: StreamUsage | null }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_start"; index: number; id: string; name: string; arguments?: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments: string }
  | { type: "usage"; usage: StreamUsage }
  | { type: "finish"; reason: string | null };

export type IntermediateStreamResult = {
  stream: ReadableStream<IntermediateStreamEvent>;
  completionText: () => string;
  firstTokenAt: () => number | null;
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

export type StreamTransformResult = {
  stream: ReadableStream<Uint8Array>;
  completionText: () => string;
  firstTokenAt: () => number | null;
};

export type PassthroughEventTracker = (event: string, data: string) => {
  completionText?: string;
  firstToken?: boolean;
} | null;

export function createPassthroughStream(
  upstream: ReadableStream<Uint8Array>,
  trackEvent: PassthroughEventTracker,
): StreamTransformResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let completionText = "";
  let buffer = "";
  let firstTokenAt: number | null = null;
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
          const decoded = decoder.decode(value, { stream: true });
          buffer += decoded.replace(/\r\n/g, "\n");

          while (true) {
            const idx = buffer.indexOf("\n\n");
            if (idx === -1) break;
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let eventName = "";
            const dataLines: string[] = [];
            for (const line of rawEvent.split("\n")) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
            }
            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n");
            if (data === "[DONE]") continue;

            try {
              const tracked = trackEvent(eventName, data);
              if (tracked?.completionText) {
                markFirstToken();
                completionText += tracked.completionText;
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
    firstTokenAt: () => firstTokenAt,
  };
}

import { durationNs } from "@/lib/gateway/ollama-adapter/response";
import { statesToToolCalls, updateToolCallState } from "@/lib/gateway/ollama-adapter/tool-calls";
import type { JsonRecord, ToolCallState, Usage } from "@/lib/gateway/ollama-adapter/types";
import { asArray, asRecord } from "@/lib/gateway/ollama-adapter/utils";

function parseChatChunk(data: string) {
  const parsed = JSON.parse(data) as JsonRecord;
  const error = asRecord(parsed.error);
  const errorMessage = typeof parsed.error === "string"
    ? parsed.error
    : typeof error?.message === "string"
      ? error.message
      : null;
  const firstChoice = asRecord(asArray(parsed.choices)[0]);
  const delta = asRecord(firstChoice?.delta);
  const usage = asRecord(parsed.usage);
  return {
    error: errorMessage,
    content: typeof delta?.content === "string" ? delta.content : "",
    reasoning: typeof delta?.reasoning === "string"
      ? delta.reasoning
      : typeof delta?.reasoning_content === "string"
        ? delta.reasoning_content
        : "",
    toolCalls: asArray(delta?.tool_calls),
    finishReason: typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : null,
    usage: usage
      ? {
          prompt_tokens: Number(usage.prompt_tokens ?? 0),
          completion_tokens: Number(usage.completion_tokens ?? 0),
          total_tokens: Number(usage.total_tokens ?? 0),
        }
      : null,
  };
}

export function createChatCompletionToOllamaStream(upstream: ReadableStream<Uint8Array>, model: string, startedAt: number) {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const toolCallStates = new Map<number, ToolCallState>();
  let buffer = "";
  let doneEmitted = false;
  let finishReason: string | null = null;
  let usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, payload: JsonRecord) => {
    controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
  };

  const emitDone = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (doneEmitted) return;
    doneEmitted = true;

    const toolCalls = statesToToolCalls(toolCallStates);
    if (toolCalls.length > 0) {
      emit(controller, {
        model,
        created_at: new Date().toISOString(),
        message: {
          role: "assistant",
          content: "",
          tool_calls: toolCalls,
        },
        done: false,
      });
    }

    emit(controller, {
      model,
      created_at: new Date().toISOString(),
      done: true,
      done_reason: finishReason ?? "stop",
      total_duration: durationNs(startedAt),
      load_duration: 0,
      prompt_eval_count: usage.prompt_tokens,
      prompt_eval_duration: 0,
      eval_count: usage.completion_tokens,
      eval_duration: 0,
    });
  };

  const processEvent = (rawEvent: string, controller: ReadableStreamDefaultController<Uint8Array>) => {
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }

    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      emitDone(controller);
      return;
    }

    let chunk: ReturnType<typeof parseChatChunk>;
    try {
      chunk = parseChatChunk(data);
    } catch {
      return;
    }
    if (chunk.error) {
      emit(controller, { error: chunk.error });
      finishReason = "error";
      emitDone(controller);
      return;
    }
    if (chunk.finishReason) finishReason = chunk.finishReason;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.toolCalls.length > 0) updateToolCallState(toolCallStates, chunk.toolCalls);

    const content = chunk.content || chunk.reasoning;
    if (!content) return;

    const message: JsonRecord = {
      role: "assistant",
      content: chunk.content,
    };
    if (!chunk.content && chunk.reasoning) {
      message.thinking = chunk.reasoning;
    }

    emit(controller, {
      model,
      created_at: new Date().toISOString(),
      message,
      done: false,
    });
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          while (true) {
            const idx = buffer.indexOf("\n\n");
            if (idx === -1) break;
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            processEvent(rawEvent, controller);
          }
        }

        if (buffer.trim()) processEvent(buffer, controller);
        emitDone(controller);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      void reader.cancel();
    },
  });
}

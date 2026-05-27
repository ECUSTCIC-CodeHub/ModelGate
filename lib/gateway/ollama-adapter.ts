type JsonRecord = Record<string, unknown>;

type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

type ToolCallState = {
  id?: string;
  name: string;
  arguments: string;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

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

function parseToolArguments(value: unknown) {
  if (asRecord(value)) return value;
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed) ?? {};
  } catch {
    return { raw: value };
  }
}

function normalizeToolCalls(value: unknown) {
  return asArray(value)
    .map((item) => {
      const record = asRecord(item);
      const fn = asRecord(record?.function);
      if (!record || !fn || typeof fn.name !== "string") return null;
      return {
        function: {
          name: fn.name,
          arguments: parseToolArguments(fn.arguments),
        },
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

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

function durationNs(startedAt: number) {
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

function updateToolCallState(states: Map<number, ToolCallState>, rawToolCalls: unknown[]) {
  rawToolCalls.forEach((item, fallbackIndex) => {
    const record = asRecord(item);
    if (!record) return;

    const index = Number(record.index ?? fallbackIndex);
    const key = Number.isFinite(index) ? index : fallbackIndex;
    const fn = asRecord(record.function);
    const current = states.get(key) ?? { name: "", arguments: "" };

    if (typeof record.id === "string" && record.id) current.id = record.id;
    if (typeof fn?.name === "string") current.name += fn.name;
    if (typeof fn?.arguments === "string") current.arguments += fn.arguments;

    states.set(key, current);
  });
}

function statesToToolCalls(states: Map<number, ToolCallState>) {
  return [...states.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, state]) => ({
      function: {
        name: state.name,
        arguments: parseToolArguments(state.arguments),
      },
    }))
    .filter((item) => item.function.name.length > 0);
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

export function ollamaErrorBody(text: string, status: number) {
  let message = text.trim() || `请求失败 (${status})`;
  try {
    const parsed = JSON.parse(text) as JsonRecord;
    const error = asRecord(parsed.error);
    message = typeof parsed.error === "string"
      ? parsed.error
      : typeof error?.message === "string"
        ? error.message
        : typeof parsed.message === "string"
          ? parsed.message
          : message;
  } catch {
    // Keep the plain text fallback.
  }
  return JSON.stringify({ error: message });
}

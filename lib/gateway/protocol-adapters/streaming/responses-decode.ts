import { asArray, asRecord, type JsonRecord } from "@/lib/gateway/normalized-message";
import { extractResponsesMessage } from "@/lib/gateway/protocol-adapters/responses-response";
import {
  type IntermediateStreamEvent,
  type IntermediateStreamResult,
  type StreamUsage,
} from "@/lib/gateway/protocol-adapters/streaming/common";
import {
  createdToUnix,
  parseResponsesSseEvent,
  usageFromResponses,
} from "@/lib/gateway/protocol-adapters/streaming/responses-events";
import { createSseFrameReader, isDoneSentinel } from "@/lib/shared/sse-frames";
import { upstreamErrorText } from "@/lib/gateway/protocol-adapters/intermediate";

// response.incomplete 表示上游因长度上限或内容过滤提前终止，
// 其 reason 在 incomplete_details 里，需要换算回中间协议的 stop_reason
function incompleteFinishReason(response: JsonRecord | null) {
  if (response?.status !== "incomplete") return "stop";
  const reason = asRecord(response.incomplete_details)?.reason;
  if (reason === "max_output_tokens") return "length";
  if (reason === "content_filter") return "content_filter";
  return "stop";
}

type ResponsesToolState = {
  index: number;
  itemId: string;
  callId: string;
  name: string;
  // 上游已给出的参数累计（收到即记，不代表已下发）
  received: string;
  // 已经下发给客户端的参数累计
  arguments: string;
  // 上游在 output_item.added 里声明的完整参数，只在流收尾且始终没有增量时兜底下发
  declared: string;
  // 是否已下发 tool_call_start：名称可能晚于调用项建立才到，而 Anthropic 出口会在
  // content_block_start 固化 name，空名先声明就纠正不回来，因此推迟到名称可用再声明
  started: boolean;
};

export function decodeResponsesStream(upstream: ReadableStream<Uint8Array>): IntermediateStreamResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const frameReader = createSseFrameReader();
  let responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  let model: string | null = null;
  let created = Math.floor(Date.now() / 1000);
  let usage: StreamUsage | null = null;
  let completionText = "";
  let reasoningText = "";
  let firstTokenAt: number | null = null;
  let started = false;
  let finished = false;
  let finishReason: string | null = null;
  let lastResponse: JsonRecord | null = null;
  const toolsByItemId = new Map<string, ResponsesToolState>();
  const toolsByIndex = new Map<number, ResponsesToolState>();

  const markFirstToken = () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  };

  const responseFromPayload = (payload: JsonRecord | null) => {
    const response = asRecord(payload?.response);
    if (response) return response;
    if (!payload) return null;
    return payload.output !== undefined || payload.output_text !== undefined || payload.usage !== undefined
      ? payload
      : null;
  };

  const updateResponseMetadata = (response: JsonRecord | null) => {
    if (!response) return;
    lastResponse = response;
    if (typeof response.id === "string") responseId = response.id;
    if (typeof response.model === "string") model = response.model;
    if (response.created_at !== undefined || response.created !== undefined) {
      created = createdToUnix(response.created_at ?? response.created);
    }
    usage = usageFromResponses(response.usage) ?? usage;
    const output = asArray(response.output).map((item) => asRecord(item)).filter((item): item is JsonRecord => Boolean(item));
    if (output.some((item) => item.type === "function_call")) {
      finishReason = "tool_calls";
    }
  };

  const rememberTool = (item: JsonRecord | null, itemId: string, outputIndex: number) => {
    const existing = toolsByItemId.get(itemId);
    if (existing) {
      if (!existing.name && typeof item?.name === "string") existing.name = item.name;
      if (!existing.declared && typeof item?.arguments === "string") existing.declared = item.arguments;
      return existing;
    }

    const callId = typeof item?.call_id === "string"
      ? item.call_id
      : typeof item?.id === "string"
        ? item.id
        : itemId || `call_${crypto.randomUUID().replace(/-/g, "")}`;
    const state: ResponsesToolState = {
      index: outputIndex,
      itemId: typeof item?.id === "string" ? item.id : itemId || callId,
      callId,
      name: typeof item?.name === "string" ? item.name : "",
      // output_item.added 的 arguments 不作为已下发内容：官方上游这里恒为空串，
      // 而提前给出完整参数的兼容上游随后会把同一段参数当增量重发，
      // 两边都收会让客户端把参数拼两遍（如 "{}{}"）。参数统一由增量与完成事件构建。
      received: "",
      arguments: "",
      declared: typeof item?.arguments === "string" ? item.arguments : "",
      started: false,
    };
    toolsByItemId.set(state.itemId, state);
    toolsByItemId.set(state.callId, state);
    toolsByIndex.set(state.index, state);
    finishReason = "tool_calls";
    return state;
  };

  // 名称可能晚于调用项建立才到（added 带空 name、done 或 completed 快照才给），
  // 而 Anthropic 出口会在 content_block_start 时固化 name，空名先声明就纠正不回来，
  // 所以声明推迟到名称可用之后
  const emitToolStart = (
    controller: ReadableStreamDefaultController<IntermediateStreamEvent>,
    state: ResponsesToolState,
    force = false,
  ) => {
    if (state.started) return;
    // 名称缺失时先不声明；force 只允许在流收尾使用，中途强制声明会固化空名
    if (!state.name && !force) return;
    state.started = true;
    controller.enqueue({
      type: "tool_call_start",
      index: state.index,
      id: state.callId,
      name: state.name,
    });
  };

  // 参数是纯追加语义：收到的先攒在 received，声明成功后再把差值下发出去。
  // arguments 只在这里被推进且总等于当时的 received，因此恒为其前缀
  const flushToolArguments = (controller: ReadableStreamDefaultController<IntermediateStreamEvent>, state: ResponsesToolState) => {
    if (!state.started) return;
    const delta = state.received.slice(state.arguments.length);
    if (!delta) return;
    state.arguments = state.received;
    controller.enqueue({
      type: "tool_call_delta",
      index: state.index,
      id: state.callId,
      name: state.name,
      arguments: delta,
    });
  };

  const declareTool = (controller: ReadableStreamDefaultController<IntermediateStreamEvent>, state: ResponsesToolState) => {
    emitToolStart(controller, state);
    flushToolArguments(controller, state);
  };

  const appendToolArguments = (
    controller: ReadableStreamDefaultController<IntermediateStreamEvent>,
    state: ResponsesToolState,
    delta: string,
  ) => {
    if (!delta) return;
    state.received += delta;
    declareTool(controller, state);
  };

  // 终止事件给的是完整参数，只有它能接在已给出内容后面时才补差值
  const applyFullToolArguments = (
    controller: ReadableStreamDefaultController<IntermediateStreamEvent>,
    state: ResponsesToolState,
    full: string,
  ) => {
    if (full === state.received) {
      // 参数与已收内容一致：借这个完整信号尽早声明，并补发可能还没下发的尾部
      declareTool(controller, state);
      return;
    }
    // 与已给出内容对不上说明上游在终止事件里改写了参数。参数是纯追加语义，
    // 客户端已累积的前缀无法回收，再补一份完整值只会拼出两段 JSON，
    // 因此沿用已有内容，宁可少一段也不制造重复参数
    if (!full.startsWith(state.received)) return;
    state.received = full;
    declareTool(controller, state);
  };

  // 收尾时把还没声明的调用补上：上游只在 output_item.added 里给过参数、之后既没有增量
  // 也没有完成事件时用声明的参数兜底；名称始终缺失时也强制声明，避免调用整体丢失
  const finishTools = (controller: ReadableStreamDefaultController<IntermediateStreamEvent>) => {
    // 同一状态登记在多个键下，按对象身份去重避免重复下发；遍历 toolsByItemId 是因为
    // 异常上游复用 output_index 时，被覆盖的 state 只留在这个 map 里
    const seen = new Set<ResponsesToolState>();
    for (const tool of toolsByItemId.values()) {
      if (seen.has(tool)) continue;
      seen.add(tool);
      if (!tool.received && tool.declared) {
        tool.received = tool.declared;
      }
      if (!tool.received) continue;
      // 收尾是最后一次机会，名称仍缺失也要声明，否则整个调用会丢
      emitToolStart(controller, tool, true);
      flushToolArguments(controller, tool);
    }
  };

  const emitStart = (controller: ReadableStreamDefaultController<IntermediateStreamEvent>) => {
    if (started) return;
    started = true;
    controller.enqueue({ type: "start", id: responseId, model, created, usage });
  };

  const emitMissingText = (
    controller: ReadableStreamDefaultController<IntermediateStreamEvent>,
    finalText: string,
  ) => {
    if (!finalText || finalText === completionText) return;
    if (completionText && !finalText.startsWith(completionText)) return;
    const delta = finalText.slice(completionText.length);
    if (!delta) return;
    emitStart(controller);
    markFirstToken();
    completionText += delta;
    controller.enqueue({ type: "text_delta", text: delta });
  };

  const emitMissingReasoning = (
    controller: ReadableStreamDefaultController<IntermediateStreamEvent>,
    finalText: string,
  ) => {
    if (!finalText || finalText === reasoningText) return;
    if (reasoningText && !finalText.startsWith(reasoningText)) return;
    const delta = finalText.slice(reasoningText.length);
    if (!delta) return;
    emitStart(controller);
    markFirstToken();
    reasoningText += delta;
    controller.enqueue({ type: "reasoning_delta", text: delta });
  };

  const emitTextPart = (
    controller: ReadableStreamDefaultController<IntermediateStreamEvent>,
    text: string,
  ) => {
    if (!text || completionText.endsWith(text)) return;
    emitStart(controller);
    markFirstToken();
    completionText += text;
    controller.enqueue({ type: "text_delta", text });
  };

  const emitReasoningPart = (
    controller: ReadableStreamDefaultController<IntermediateStreamEvent>,
    text: string,
  ) => {
    if (!text || reasoningText.endsWith(text)) return;
    emitStart(controller);
    markFirstToken();
    reasoningText += text;
    controller.enqueue({ type: "reasoning_delta", text });
  };

  const emitContentPart = (
    controller: ReadableStreamDefaultController<IntermediateStreamEvent>,
    part: JsonRecord | null,
  ) => {
    if (!part) return;
    const type = typeof part.type === "string" ? part.type : "";
    const text = typeof part.text === "string"
      ? part.text
      : typeof part.thinking === "string"
        ? part.thinking
        : "";
    if (!text) return;

    if (type === "output_text" || type === "text") {
      emitTextPart(controller, text);
      return;
    }
    if (type === "reasoning_text" || type === "reasoning" || type === "thinking" || type === "summary_text") {
      emitReasoningPart(controller, text);
    }
  };

  const emitMissingResponseOutput = (
    controller: ReadableStreamDefaultController<IntermediateStreamEvent>,
    response: JsonRecord | null,
  ) => {
    if (!response) return;
    const extracted = extractResponsesMessage(response.output, response.output_text);
    emitMissingReasoning(controller, extracted.reasoning);
    emitMissingText(controller, extracted.text);

    const output = asArray(response.output).map((item) => asRecord(item)).filter((item): item is JsonRecord => Boolean(item));
    output.forEach((item, outputIndex) => {
      if (item.type !== "function_call") return;
      emitStart(controller);
      const itemId = typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : "";
      const existing = toolsByItemId.get(itemId) ?? toolsByIndex.get(outputIndex);
      const tool = existing ?? rememberTool(item, itemId, outputIndex);
      if (!tool.name && typeof item.name === "string") tool.name = item.name;
      declareTool(controller, tool);
      if (typeof item.arguments === "string") {
        applyFullToolArguments(controller, tool, item.arguments);
      }
    });
  };

  const stream = new ReadableStream<IntermediateStreamEvent>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          for (const frame of frameReader.push(decoder.decode(value, { stream: true }))) {
            if (!frame.hasData) continue;
            if (isDoneSentinel(frame.data)) continue;

            const event = parseResponsesSseEvent(frame.event, frame.data);
            const payload = asRecord(event.data);
            const response = responseFromPayload(payload);
            updateResponseMetadata(response);

            if (event.event === "response.failed" || event.event === "error") {
              // 上游失败事件必须终止转发并透出真实信息，否则流会在没有 finish 的情况下
              // 结束，被下游当成正常截断
              throw new Error(`上游流式返回错误: ${upstreamErrorText(response?.error ?? payload?.error)}`);
            }

            if (event.event === "response.created" || event.event === "response.in_progress") {
              emitStart(controller);
              continue;
            }

            if (event.event === "response.output_text.delta" && typeof payload?.delta === "string") {
              emitStart(controller);
              markFirstToken();
              completionText += payload.delta;
              controller.enqueue({ type: "text_delta", text: payload.delta });
              continue;
            }

            if (event.event === "response.reasoning_text.delta" && typeof payload?.delta === "string") {
              emitStart(controller);
              markFirstToken();
              reasoningText += payload.delta;
              controller.enqueue({ type: "reasoning_delta", text: payload.delta });
              continue;
            }

            if (event.event === "response.reasoning_summary_text.delta" && typeof payload?.delta === "string") {
              emitStart(controller);
              markFirstToken();
              reasoningText += payload.delta;
              controller.enqueue({ type: "reasoning_delta", text: payload.delta });
              continue;
            }

            if (event.event === "response.output_text.done" && typeof payload?.text === "string") {
              emitMissingText(controller, payload.text);
              continue;
            }

            if (
              (event.event === "response.reasoning_text.done" || event.event === "response.reasoning_summary_text.done") &&
              typeof payload?.text === "string"
            ) {
              emitMissingReasoning(controller, payload.text);
              continue;
            }

            if (event.event === "response.content_part.done") {
              emitContentPart(controller, asRecord(payload?.part) ?? asRecord(payload?.content_part));
              continue;
            }

            if (event.event === "response.output_item.added") {
              const item = asRecord(payload?.item);
              if (item?.type === "function_call") {
                emitStart(controller);
                const outputIndex = Number(payload?.output_index ?? toolsByIndex.size);
                const itemId = typeof item.id === "string" ? item.id : typeof payload?.item_id === "string" ? payload.item_id : "";
                const tool = rememberTool(item, itemId, outputIndex);
                // 名称缺失时先不声明，等 done 或 completed 快照补上名字再发
                declareTool(controller, tool);
              }
              continue;
            }

            if (event.event === "response.function_call_arguments.delta" && typeof payload?.delta === "string") {
              emitStart(controller);
              const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
              const outputIndex = Number(payload.output_index ?? toolsByIndex.size);
              const tool = toolsByItemId.get(itemId) ?? rememberTool(null, itemId, outputIndex);
              appendToolArguments(controller, tool, payload.delta);
              continue;
            }

            if (event.event === "response.function_call_arguments.done" && typeof payload?.arguments === "string") {
              emitStart(controller);
              const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
              const outputIndex = Number(payload.output_index ?? toolsByIndex.size);
              const tool = toolsByItemId.get(itemId) ?? rememberTool(null, itemId, outputIndex);
              applyFullToolArguments(controller, tool, payload.arguments);
              continue;
            }

            if (event.event === "response.output_item.done") {
              const item = asRecord(payload?.item);
              if (item?.type === "function_call") {
                emitStart(controller);
                const outputIndex = Number(payload?.output_index ?? toolsByIndex.size);
                const itemId = typeof item.id === "string" ? item.id : typeof payload?.item_id === "string" ? payload.item_id : "";
                const tool = toolsByItemId.get(itemId) ?? rememberTool(item, itemId, outputIndex);
                if (!tool.name && typeof item.name === "string") tool.name = item.name;
                declareTool(controller, tool);
                if (typeof item.arguments === "string") {
                  applyFullToolArguments(controller, tool, item.arguments);
                }
              } else if (item?.type === "message" || item?.type === "reasoning") {
                emitMissingResponseOutput(controller, { output: [item] });
              }
              continue;
            }

            if (event.event === "response.completed" || event.event === "response.incomplete") {
              emitStart(controller);
              emitMissingResponseOutput(controller, response);
              finishTools(controller);
              if (usage) controller.enqueue({ type: "usage", usage });
              if (!finished) {
                finished = true;
                controller.enqueue({ type: "finish", reason: finishReason ?? incompleteFinishReason(response) });
              }
            }
          }
        }

        if (started && !finished) {
          emitMissingResponseOutput(controller, lastResponse);
          finishTools(controller);
          if (usage) controller.enqueue({ type: "usage", usage });
          controller.enqueue({ type: "finish", reason: finishReason ?? "stop" });
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
    reasoningText: () => reasoningText,
    firstTokenAt: () => firstTokenAt,
    usage: () => usage,
  };
}

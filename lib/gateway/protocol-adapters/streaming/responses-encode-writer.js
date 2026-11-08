import { toSseBlock, } from "@/lib/gateway/protocol-adapters/streaming/common";
import { createReasoningOutputItem, createTextOutputItem, createToolOutputItem, } from "@/lib/gateway/protocol-adapters/streaming/responses-encode-items";
import { responseUsage } from "@/lib/gateway/protocol-adapters/streaming/responses-events";
import { createStreamUsageFallback } from "@/lib/gateway/protocol-adapters/streaming/usage-fallback";
export class ResponsesStreamWriter {
    encoder;
    responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
    model = null;
    created = Math.floor(Date.now() / 1000);
    usage = null;
    started = false;
    finished = false;
    failed = false;
    nextOutputIndex = 0;
    reasoningStarted = false;
    reasoningDone = false;
    reasoningText = "";
    reasoningOutputIndex = 0;
    reasoningItemId = `rs_${crypto.randomUUID().replace(/-/g, "")}`;
    textStarted = false;
    textDone = false;
    text = "";
    textOutputIndex = 0;
    outputMessageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    tools = new Map();
    // 上游没在 response.completed 里给 usage 时不能回 undefined，用与账务侧同一个分词器兜底
    meter;
    constructor(encoder, options) {
        this.encoder = encoder;
        this.meter = createStreamUsageFallback({
            promptTokens: options?.streamPromptTokens,
            model: options?.streamUsageModel,
        });
    }
    applyStart(event, controller) {
        if (event.id)
            this.responseId = event.id;
        if (event.model !== undefined)
            this.model = event.model;
        if (event.created)
            this.created = event.created;
        if (event.usage)
            this.usage = event.usage;
        this.ensureStarted(controller);
    }
    applyUsage(event) {
        this.usage = event.usage;
    }
    writeReasoningDelta(event, controller) {
        this.ensureReasoning(controller);
        this.reasoningText += event.text;
        this.meter.observeReasoning(event.text);
        this.emit(controller, "response.reasoning_text.delta", {
            type: "response.reasoning_text.delta",
            response_id: this.responseId,
            item_id: this.reasoningItemId,
            output_index: this.reasoningOutputIndex,
            content_index: 0,
            delta: event.text,
        });
    }
    writeTextDelta(event, controller) {
        this.ensureText(controller);
        this.text += event.text;
        this.meter.observeText(event.text);
        this.emit(controller, "response.output_text.delta", {
            type: "response.output_text.delta",
            response_id: this.responseId,
            item_id: this.outputMessageId,
            output_index: this.textOutputIndex,
            content_index: 0,
            delta: event.text,
        });
    }
    ensureToolCall(event, controller) {
        const existing = this.tools.get(event.index);
        if (existing)
            return existing;
        this.ensureStarted(controller);
        const callId = event.id ?? `call_${crypto.randomUUID().replace(/-/g, "")}`;
        const tool = {
            index: event.index,
            itemId: `fc_${crypto.randomUUID().replace(/-/g, "")}`,
            callId,
            name: event.name ?? "",
            arguments: event.type === "tool_call_start" ? event.arguments ?? "" : "",
            outputIndex: this.nextOutputIndex,
            done: false,
        };
        this.nextOutputIndex += 1;
        this.tools.set(event.index, tool);
        this.meter.observeToolCall(tool.name, tool.arguments);
        this.emit(controller, "response.output_item.added", {
            type: "response.output_item.added",
            response_id: this.responseId,
            output_index: tool.outputIndex,
            item: {
                type: "function_call",
                id: tool.itemId,
                call_id: tool.callId,
                name: tool.name,
                arguments: tool.arguments,
                status: "in_progress",
            },
        });
        return tool;
    }
    writeToolCallDelta(event, controller) {
        const tool = this.ensureToolCall(event, controller);
        if (event.name)
            tool.name = event.name;
        tool.arguments += event.arguments;
        this.meter.observeToolArguments(event.arguments);
        this.emit(controller, "response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            response_id: this.responseId,
            item_id: tool.itemId,
            output_index: tool.outputIndex,
            delta: event.arguments,
        });
    }
    writeDone(controller, reason) {
        if (this.finished)
            return;
        this.finished = true;
        this.ensureStarted(controller);
        this.doneReasoning(controller);
        this.doneText(controller);
        for (const tool of this.sortedTools()) {
            this.doneTool(controller, tool);
        }
        const output = [
            ...(this.reasoningStarted ? [this.reasoningOutputItem()] : []),
            ...(this.textStarted || this.tools.size === 0 ? [this.textOutputItem()] : []),
            ...this.sortedTools().map((tool) => this.toolOutputItem(tool)),
        ];
        // 因长度上限终止时，Responses 协议要求 status=incomplete 而不是 completed
        const incompleteReason = reason === "length"
            ? "max_output_tokens"
            : reason === "content_filter" ? "content_filter" : null;
        const status = incompleteReason ? "incomplete" : "completed";
        this.emit(controller, `response.${status}`, {
            type: `response.${status}`,
            response: {
                ...this.responseBase(status),
                output,
                output_text: this.text,
                usage: responseUsage(this.finalUsage()),
                ...(incompleteReason ? { incomplete_details: { reason: incompleteReason } } : {}),
            },
        });
    }
    writeFailed(controller, message) {
        if (this.failed)
            return;
        this.failed = true;
        this.finished = true;
        this.ensureStarted(controller);
        this.doneReasoning(controller);
        this.doneText(controller);
        for (const tool of this.sortedTools()) {
            this.doneTool(controller, tool);
        }
        const output = [
            ...(this.reasoningStarted ? [this.reasoningOutputItem()] : []),
            ...(this.textStarted || this.tools.size === 0 ? [this.textOutputItem()] : []),
            ...this.sortedTools().map((tool) => this.toolOutputItem(tool)),
        ];
        this.emit(controller, "response.failed", {
            type: "response.failed",
            response: {
                ...this.responseBase("failed"),
                output,
                output_text: this.text,
                usage: responseUsage(this.finalUsage()),
                error: { code: "upstream_error", message },
            },
        });
    }
    // 上游给了 usage 就用上游值，缺失或输出为 0 时补本地分词结果，口径与 Anthropic / Chat 出口一致
    finalUsage() {
        return this.meter.complete(this.usage, this.model);
    }
    emit(controller, event, payload) {
        controller.enqueue(this.encoder.encode(toSseBlock(event, payload)));
    }
    responseBase(status) {
        return {
            id: this.responseId,
            object: "response",
            created_at: this.created,
            model: this.model,
            status,
        };
    }
    ensureStarted(controller) {
        if (this.started)
            return;
        this.started = true;
        this.emit(controller, "response.created", {
            type: "response.created",
            response: {
                ...this.responseBase("in_progress"),
                output: [],
            },
        });
        this.emit(controller, "response.in_progress", {
            type: "response.in_progress",
            response: {
                ...this.responseBase("in_progress"),
                output: [],
            },
        });
    }
    ensureReasoning(controller) {
        if (this.reasoningStarted)
            return;
        this.ensureStarted(controller);
        this.reasoningStarted = true;
        this.reasoningOutputIndex = this.nextOutputIndex;
        this.nextOutputIndex += 1;
        this.emit(controller, "response.output_item.added", {
            type: "response.output_item.added",
            response_id: this.responseId,
            output_index: this.reasoningOutputIndex,
            item: {
                id: this.reasoningItemId,
                type: "reasoning",
                summary: [],
                content: [],
                status: "in_progress",
            },
        });
    }
    ensureText(controller) {
        if (this.textStarted)
            return;
        this.ensureStarted(controller);
        this.textStarted = true;
        this.textOutputIndex = this.nextOutputIndex;
        this.nextOutputIndex += 1;
        this.emit(controller, "response.output_item.added", {
            type: "response.output_item.added",
            response_id: this.responseId,
            output_index: this.textOutputIndex,
            item: {
                id: this.outputMessageId,
                type: "message",
                role: "assistant",
                status: "in_progress",
                content: [],
            },
        });
        this.emit(controller, "response.content_part.added", {
            type: "response.content_part.added",
            response_id: this.responseId,
            item_id: this.outputMessageId,
            output_index: this.textOutputIndex,
            content_index: 0,
            part: {
                type: "output_text",
                text: "",
                annotations: [],
            },
        });
    }
    reasoningOutputItem() {
        return createReasoningOutputItem(this.reasoningItemId, this.reasoningText);
    }
    textOutputItem() {
        return createTextOutputItem(this.outputMessageId, this.text);
    }
    toolOutputItem(tool) {
        return createToolOutputItem(tool);
    }
    doneReasoning(controller) {
        if (!this.reasoningStarted || this.reasoningDone)
            return;
        this.reasoningDone = true;
        this.emit(controller, "response.reasoning_text.done", {
            type: "response.reasoning_text.done",
            response_id: this.responseId,
            item_id: this.reasoningItemId,
            output_index: this.reasoningOutputIndex,
            content_index: 0,
            text: this.reasoningText,
        });
        this.emit(controller, "response.output_item.done", {
            type: "response.output_item.done",
            response_id: this.responseId,
            output_index: this.reasoningOutputIndex,
            item: this.reasoningOutputItem(),
        });
    }
    doneText(controller) {
        if (!this.textStarted || this.textDone)
            return;
        this.textDone = true;
        this.emit(controller, "response.output_text.done", {
            type: "response.output_text.done",
            response_id: this.responseId,
            item_id: this.outputMessageId,
            output_index: this.textOutputIndex,
            content_index: 0,
            text: this.text,
        });
        this.emit(controller, "response.output_item.done", {
            type: "response.output_item.done",
            response_id: this.responseId,
            output_index: this.textOutputIndex,
            item: this.textOutputItem(),
        });
    }
    doneTool(controller, tool) {
        if (tool.done)
            return;
        tool.done = true;
        this.emit(controller, "response.function_call_arguments.done", {
            type: "response.function_call_arguments.done",
            response_id: this.responseId,
            item_id: tool.itemId,
            output_index: tool.outputIndex,
            arguments: tool.arguments,
        });
        this.emit(controller, "response.output_item.done", {
            type: "response.output_item.done",
            response_id: this.responseId,
            output_index: tool.outputIndex,
            item: this.toolOutputItem(tool),
        });
    }
    sortedTools() {
        return [...this.tools.values()].sort((a, b) => a.outputIndex - b.outputIndex);
    }
}

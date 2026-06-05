import { asArray, asRecord, type JsonRecord } from "@/lib/gateway/normalized-message";
import type { GatewayProtocol } from "@/lib/gateway/protocols";
import type { IntermediateTool, IntermediateToolChoice } from "@/lib/gateway/protocol-adapters/intermediate";

function collectResponsesFunctionTools(tools: unknown): JsonRecord[] {
  return asArray(tools).reduce<JsonRecord[]>((acc, tool) => {
    const record = asRecord(tool);
    if (!record || record.type !== "function") return acc;
    acc.push(record);
    return acc;
  }, []);
}

export function downgradeResponsesRequestForRoute(body: Record<string, unknown>, upstreamProtocol: GatewayProtocol): Record<string, unknown> {
  if (upstreamProtocol !== "chat_completions") return body;

  const functionTools = collectResponsesFunctionTools(body.tools);
  const next: Record<string, unknown> = { ...body };

  if (body.tools !== undefined) {
    next.tools = functionTools.length > 0 ? functionTools : undefined;
  }

  if (body.tool_choice !== undefined) {
    next.tool_choice = reconcileResponsesToolChoice(body.tool_choice, next.tools);
  }

  return next;
}

export function getResponsesRouteCompatibilityNote(body: Record<string, unknown>, upstreamProtocol: GatewayProtocol) {
  if (upstreamProtocol !== "chat_completions" || body.tools === undefined) return null;
  const totalTools = asArray(body.tools).length;
  const functionTools = collectResponsesFunctionTools(body.tools);
  if (totalTools === 0 || totalTools === functionTools.length) return null;
  return `当前 chat_completions 路由已忽略 ${totalTools - functionTools.length} 个非 function Responses tools，仅保留可映射的 function tools。`;
}

function reconcileResponsesToolChoice(toolChoice: unknown, tools: unknown): unknown {
  if (toolChoice === undefined) return undefined;
  if (toolChoice === "auto" || toolChoice === "none") return toolChoice;

  const functionTools = collectResponsesFunctionTools(tools);
  if (functionTools.length === 0) return undefined;
  if (toolChoice === "required") return "required";

  const record = asRecord(toolChoice);
  const requestedName = record?.type === "function" && typeof record.name === "string" ? record.name : null;
  if (!requestedName) return "auto";

  const availableNames = new Set(functionTools.map((tool) => (typeof tool.name === "string" ? tool.name : "")).filter(Boolean));
  return availableNames.has(requestedName) ? toolChoice : "auto";
}

export function chatToolsToIntermediate(tools: unknown): IntermediateTool[] | undefined {
  const converted = asArray(tools).reduce<IntermediateTool[]>((acc, tool) => {
    const record = asRecord(tool);
    if (!record || record.type !== "function") return acc;
    const fn = asRecord(record.function);
    if (!fn) return acc;
    acc.push({
      type: "function",
      name: typeof fn.name === "string" ? fn.name : "",
      description: typeof fn.description === "string" ? fn.description : undefined,
      parameters: asRecord(fn.parameters) ?? fn.parameters,
      strict: typeof fn.strict === "boolean" ? fn.strict : undefined,
    });
    return acc;
  }, []);

  return converted.length > 0 ? converted : undefined;
}

export function responsesToolsToIntermediate(tools: unknown): IntermediateTool[] | undefined {
  const converted = asArray(tools).reduce<IntermediateTool[]>((acc, tool) => {
    const record = asRecord(tool);
    if (!record || record.type !== "function") return acc;
    acc.push({
      type: "function",
      name: typeof record.name === "string" ? record.name : "",
      description: typeof record.description === "string" ? record.description : undefined,
      parameters: asRecord(record.parameters) ?? record.parameters,
      strict: typeof record.strict === "boolean" ? record.strict : undefined,
    });
    return acc;
  }, []);

  return converted.length > 0 ? converted : undefined;
}

const ANTHROPIC_BETA_TOOL_TYPES = new Set([
  "computer",
  "bash",
  "text_editor",
]);

function isAnthropicBetaTool(record: JsonRecord): boolean {
  const type = typeof record.type === "string" ? record.type : "";
  if (ANTHROPIC_BETA_TOOL_TYPES.has(type)) return true;
  // Anthropic beta tools also have type matching patterns like computer_20241022
  if (/^(computer|bash|text_editor)_\d{8}$/.test(type)) return true;
  return false;
}

export function anthropicToolsToIntermediate(tools: unknown): IntermediateTool[] | undefined {
  const converted = asArray(tools).reduce<IntermediateTool[]>((acc, tool) => {
    const record = asRecord(tool);
    if (!record || typeof record.name !== "string") return acc;
    // Skip Anthropic beta tools (computer_*, bash_*, text_editor_*) that
    // cannot be mapped to standard function calling in other protocols.
    if (isAnthropicBetaTool(record)) return acc;
    acc.push({
      type: "function",
      name: record.name,
      description: typeof record.description === "string" ? record.description : undefined,
      parameters: asRecord(record.input_schema) ?? record.input_schema ?? { type: "object", properties: {} },
    });
    return acc;
  }, []);

  return converted.length > 0 ? converted : undefined;
}

export function toolsFromIntermediateForChat(tools: IntermediateTool[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: asRecord(tool.parameters) ?? tool.parameters,
      strict: tool.strict,
    },
  }));
}

export function toolsFromIntermediateForResponses(tools: IntermediateTool[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: asRecord(tool.parameters) ?? tool.parameters,
    strict: tool.strict,
  }));
}

export function toolsFromIntermediateForAnthropic(tools: IntermediateTool[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: asRecord(tool.parameters) ?? tool.parameters ?? { type: "object", properties: {} },
  }));
}

export function chatToolChoiceToIntermediate(toolChoice: unknown): IntermediateToolChoice | undefined {
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") return toolChoice;
  const record = asRecord(toolChoice);
  const fn = asRecord(record?.function);
  if (record?.type === "function" && typeof fn?.name === "string") {
    return { type: "function", name: fn.name };
  }
  return undefined;
}

export function responsesToolChoiceToIntermediate(toolChoice: unknown): IntermediateToolChoice | undefined {
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") return toolChoice;
  const record = asRecord(toolChoice);
  if (record?.type === "function" && typeof record.name === "string") {
    return { type: "function", name: record.name };
  }
  return undefined;
}

export function anthropicToolChoiceToIntermediate(toolChoice: unknown): IntermediateToolChoice | undefined {
  const record = asRecord(toolChoice);
  if (!record || typeof record.type !== "string") return undefined;
  if (record.type === "auto") return "auto";
  if (record.type === "any") return "required";
  if (record.type === "none") return "none";
  if (record.type === "tool" && typeof record.name === "string") {
    return { type: "function", name: record.name };
  }
  return undefined;
}

export function toolChoiceFromIntermediateForChat(toolChoice: IntermediateToolChoice | undefined) {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") return toolChoice;
  return {
    type: "function",
    function: {
      name: toolChoice.name,
    },
  };
}

export function toolChoiceFromIntermediateForResponses(toolChoice: IntermediateToolChoice | undefined) {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") return toolChoice;
  return { type: "function", name: toolChoice.name };
}

export function toolChoiceFromIntermediateForAnthropic(toolChoice: IntermediateToolChoice | undefined) {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "required") return { type: "any" };
  if (toolChoice === "none") return { type: "none" };
  return { type: "tool", name: toolChoice.name };
}

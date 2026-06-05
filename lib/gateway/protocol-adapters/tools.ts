import { asArray, asRecord } from "@/lib/gateway/normalized-message";
import type { IntermediateTool, IntermediateToolChoice } from "@/lib/gateway/protocol-adapters/intermediate";

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
  const converted = asArray(tools).reduce<IntermediateTool[]>((acc, tool, index) => {
    const record = asRecord(tool);
    if (!record) return acc;
    if (record.type !== "function") {
      throw new Error(
        `Responses tools[${index}] 使用了 ${String(record.type)} 类型工具，但当前路由只支持 function 工具转换。` +
        " 如果当前模型渠道的上游协议是 chat_completions，请改用仅包含 function tools 的请求；" +
        "如果需要 custom tools，请切换到原生支持 Responses 的上游渠道。",
      );
    }
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

export function anthropicToolsToIntermediate(tools: unknown): IntermediateTool[] | undefined {
  const converted = asArray(tools).reduce<IntermediateTool[]>((acc, tool) => {
    const record = asRecord(tool);
    if (!record || typeof record.name !== "string") return acc;
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
  if (toolChoice === "none") return undefined;
  return { type: "tool", name: toolChoice.name };
}

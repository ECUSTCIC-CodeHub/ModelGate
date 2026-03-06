import { encodingForModel, getEncoding } from "js-tiktoken";

let fallbackEncoding: ReturnType<typeof getEncoding> | null = null;

function getModelEncoding(model: string) {
  try {
    return encodingForModel(model as Parameters<typeof encodingForModel>[0]);
  } catch {
    if (!fallbackEncoding) {
      fallbackEncoding = getEncoding("cl100k_base");
    }
    return fallbackEncoding;
  }
}

export function countTextTokens(text: string, model: string) {
  if (!text) return 0;
  try {
    const encoding = getModelEncoding(model);
    return encoding.encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

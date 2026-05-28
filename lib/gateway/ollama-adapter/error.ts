import type { JsonRecord } from "@/lib/gateway/ollama-adapter/types";
import { asRecord } from "@/lib/gateway/ollama-adapter/utils";

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
  }
  return JSON.stringify({ error: message });
}

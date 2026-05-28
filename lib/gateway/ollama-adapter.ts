export { adaptOllamaChatRequestBody, isOllamaStreamRequested } from "@/lib/gateway/ollama-adapter/request";
export {
  adaptChatCompletionToOllama,
  adaptChatCompletionToOllamaStreamText,
} from "@/lib/gateway/ollama-adapter/response";
export { createChatCompletionToOllamaStream } from "@/lib/gateway/ollama-adapter/stream";
export { ollamaErrorBody } from "@/lib/gateway/ollama-adapter/error";

export const dynamic = "force-dynamic";

import { applyCorsHeaders, handleCorsPreflight } from "@/lib/core/cors";
import { handleOllamaVersionRequest } from "@/lib/gateway/ollama-handler";

export function GET(request: Request) {
  return applyCorsHeaders(handleOllamaVersionRequest(request));
}

export function OPTIONS() {
  return handleCorsPreflight();
}

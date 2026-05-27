export const dynamic = "force-dynamic";

import { applyCorsHeaders, handleCorsPreflight } from "@/lib/core/cors";
import { handleOllamaTagsRequest } from "@/lib/gateway/ollama-handler";

export function GET(request: Request) {
  return applyCorsHeaders(handleOllamaTagsRequest(request));
}

export function OPTIONS() {
  return handleCorsPreflight();
}

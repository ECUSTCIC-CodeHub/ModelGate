export const dynamic = "force-dynamic";

import { applyCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { handleOllamaTagsRequest } from "@/lib/ollama-handler";

export function GET(request: Request) {
  return applyCorsHeaders(handleOllamaTagsRequest(request));
}

export function OPTIONS() {
  return handleCorsPreflight();
}

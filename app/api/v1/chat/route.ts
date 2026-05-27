export const dynamic = "force-dynamic";

import { applyCorsHeaders, handleCorsPreflight } from "@/lib/core/cors";
import { handleOllamaChatRequest } from "@/lib/gateway/ollama-handler";

export async function POST(request: Request) {
  return applyCorsHeaders(await handleOllamaChatRequest(request));
}

export async function OPTIONS() {
  return handleCorsPreflight();
}

export const dynamic = "force-dynamic";

import { applyCorsHeaders, handleCorsPreflight } from "@/lib/core/cors";
import { handleOllamaShowRequest } from "@/lib/gateway/ollama-handler";

export async function POST(request: Request) {
  return applyCorsHeaders(await handleOllamaShowRequest(request));
}

export function OPTIONS() {
  return handleCorsPreflight();
}

export const dynamic = "force-dynamic";

import { applyCorsHeaders, handleCorsPreflight } from "@/lib/core/cors";
import { jsonError } from "@/lib/core/http";
import {
  handleOllamaChatRequest,
  handleOllamaShowRequest,
  handleOllamaTagsRequest,
  handleOllamaVersionRequest,
} from "@/lib/gateway/ollama-handler";

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

function notFound() {
  return jsonError("Ollama API 接口不存在", 404, {
    type: "not_found_error",
    param: "None",
    code: "404",
  });
}

export async function GET(request: Request, context: RouteContext) {
  const { path } = await context.params;
  const endpoint = path.join("/");

  if (endpoint === "version") return applyCorsHeaders(handleOllamaVersionRequest(request));
  if (endpoint === "tags") return applyCorsHeaders(handleOllamaTagsRequest(request));
  return applyCorsHeaders(notFound());
}

export async function POST(request: Request, context: RouteContext) {
  const { path } = await context.params;
  const endpoint = path.join("/");

  if (endpoint === "chat") return applyCorsHeaders(await handleOllamaChatRequest(request));
  if (endpoint === "show") return applyCorsHeaders(await handleOllamaShowRequest(request));
  return applyCorsHeaders(notFound());
}

export function OPTIONS() {
  return handleCorsPreflight();
}

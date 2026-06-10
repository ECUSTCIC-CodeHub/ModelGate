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

  if (endpoint === "version") return await applyCorsHeaders(await handleOllamaVersionRequest(request));
  if (endpoint === "tags") return await applyCorsHeaders(await handleOllamaTagsRequest(request));
  return await applyCorsHeaders(notFound());
}

export async function POST(request: Request, context: RouteContext) {
  const { path } = await context.params;
  const endpoint = path.join("/");

  if (endpoint === "chat") return await applyCorsHeaders(await handleOllamaChatRequest(request));
  if (endpoint === "show") return await applyCorsHeaders(await handleOllamaShowRequest(request));
  return await applyCorsHeaders(notFound());
}

export async function OPTIONS() {
  return await handleCorsPreflight();
}

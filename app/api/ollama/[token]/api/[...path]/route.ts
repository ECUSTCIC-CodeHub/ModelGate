export const dynamic = "force-dynamic";

import { applyCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { jsonError } from "@/lib/http";
import {
  handleOllamaChatRequest,
  handleOllamaShowRequest,
  handleOllamaTagsRequest,
  handleOllamaVersionRequest,
} from "@/lib/ollama-handler";

type RouteContext = {
  params: Promise<{
    token: string;
    path: string[];
  }>;
};

function withPathToken(request: Request, token: string) {
  const headers = new Headers(request.headers);
  headers.set("x-api-key", decodeURIComponent(token));
  return new Request(request, { headers });
}

function notFound() {
  return jsonError("Ollama API 接口不存在", 404, {
    type: "not_found_error",
    param: "None",
    code: "404",
  });
}

export async function GET(request: Request, context: RouteContext) {
  const { token, path } = await context.params;
  const endpoint = path.join("/");
  const authedRequest = withPathToken(request, token);

  if (endpoint === "version") return applyCorsHeaders(handleOllamaVersionRequest(authedRequest));
  if (endpoint === "tags") return applyCorsHeaders(handleOllamaTagsRequest(authedRequest));
  return applyCorsHeaders(notFound());
}

export async function POST(request: Request, context: RouteContext) {
  const { token, path } = await context.params;
  const endpoint = path.join("/");
  const authedRequest = withPathToken(request, token);

  if (endpoint === "chat") return applyCorsHeaders(await handleOllamaChatRequest(authedRequest));
  if (endpoint === "show") return applyCorsHeaders(await handleOllamaShowRequest(authedRequest));
  return applyCorsHeaders(notFound());
}

export function OPTIONS() {
  return handleCorsPreflight();
}

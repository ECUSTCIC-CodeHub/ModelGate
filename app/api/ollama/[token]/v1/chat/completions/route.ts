export const dynamic = "force-dynamic";

import { applyCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { handleGatewayProtocolRequest } from "@/lib/gateway-handler";

type RouteContext = {
  params: Promise<{ token: string }>;
};

function withPathToken(request: Request, token: string) {
  const headers = new Headers(request.headers);
  headers.set("x-api-key", decodeURIComponent(token));
  return new Request(request, { headers });
}

export async function POST(request: Request, context: RouteContext) {
  const { token } = await context.params;
  return applyCorsHeaders(await handleGatewayProtocolRequest(withPathToken(request, token), "chat_completions"));
}

export function OPTIONS() {
  return handleCorsPreflight();
}

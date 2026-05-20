export const dynamic = "force-dynamic";

import { applyCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { handleGatewayProtocolRequest } from "@/lib/gateway-handler";

export async function POST(request: Request) {
  return applyCorsHeaders(await handleGatewayProtocolRequest(request, "chat_completions"));
}

export async function OPTIONS() {
  return handleCorsPreflight();
}

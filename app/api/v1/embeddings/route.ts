export const dynamic = "force-dynamic";

import { applyCorsHeaders, handleCorsPreflight } from "@/lib/core/cors";
import { handleGatewayProtocolRequest } from "@/lib/gateway/gateway-handler";

export async function POST(request: Request) {
  return applyCorsHeaders(await handleGatewayProtocolRequest(request, "embeddings"));
}

export async function OPTIONS() {
  return handleCorsPreflight();
}

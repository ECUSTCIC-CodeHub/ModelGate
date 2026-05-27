export const dynamic = "force-dynamic";

import { applyCorsHeaders, handleCorsPreflight } from "@/lib/core/cors";
import { handleGatewayProtocolRequest } from "@/lib/gateway/gateway-handler";
import { embeddingsGatewayAdapter } from "@/lib/gateway/protocol-adapters";

export async function POST(request: Request) {
  return applyCorsHeaders(await handleGatewayProtocolRequest(request, embeddingsGatewayAdapter));
}

export async function OPTIONS() {
  return handleCorsPreflight();
}

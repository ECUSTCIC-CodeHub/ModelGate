export const dynamic = "force-dynamic";

import { applyCorsHeaders, handleCorsPreflight } from "@/lib/core/cors";
import { handleGatewayProtocolRequest } from "@/lib/gateway/gateway-handler";
import { responsesGatewayAdapter } from "@/lib/gateway/protocol-adapters";

export async function POST(request: Request) {
  return await applyCorsHeaders(await handleGatewayProtocolRequest(request, responsesGatewayAdapter));
}

export async function OPTIONS() {
  return await handleCorsPreflight();
}

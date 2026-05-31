export const dynamic = "force-dynamic";

import { applyCorsHeaders, handleCorsPreflight } from "@/lib/core/cors";
import { handleMultipartGatewayRequest } from "@/lib/gateway/multipart-gateway-handler";

export async function POST(request: Request) {
  return applyCorsHeaders(await handleMultipartGatewayRequest(request));
}

export async function OPTIONS() {
  return handleCorsPreflight();
}

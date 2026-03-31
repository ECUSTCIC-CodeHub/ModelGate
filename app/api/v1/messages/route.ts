export const dynamic = "force-dynamic";

import { handleGatewayProtocolRequest } from "@/lib/gateway-handler";

export async function POST(request: Request) {
  return handleGatewayProtocolRequest(request, "anthropic_messages");
}

export const dynamic = "force-dynamic";

import { applyCorsHeaders, handleCorsPreflight } from "@/lib/core/cors";
import { handlePassthroughRequest } from "@/lib/gateway/passthrough-handler";

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

export async function OPTIONS() {
  return await handleCorsPreflight();
}

export async function POST(request: Request, context: RouteContext) {
  const { path } = await context.params;
  return await applyCorsHeaders(await handlePassthroughRequest(request, path.join("/")));
}

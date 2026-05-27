export const dynamic = "force-dynamic";

import { GET as handleModels, OPTIONS } from "@/app/api/v1/models/route";

type RouteContext = {
  params: Promise<{ token: string }>;
};

function withPathToken(request: Request, token: string) {
  const headers = new Headers(request.headers);
  headers.set("x-api-key", decodeURIComponent(token));
  return new Request(request, { headers });
}

export async function GET(request: Request, context: RouteContext) {
  const { token } = await context.params;
  return handleModels(withPathToken(request, token));
}

export { OPTIONS };

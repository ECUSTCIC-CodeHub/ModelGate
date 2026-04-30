export const dynamic = "force-dynamic";

import { jsonError, jsonOk } from "@/lib/http";
import { ensureWebUser } from "@/lib/guards";

export async function GET(request: Request) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const url = new URL(request.url);
  const origin = url.origin;
  const authorizeUrl = new URL("/api/auth/oidc/authorize", origin);
  authorizeUrl.searchParams.set("bind", "1");

  return Response.redirect(authorizeUrl.toString(), 302);
}

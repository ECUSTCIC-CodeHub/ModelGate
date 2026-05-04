export const dynamic = "force-dynamic";

import { ensureWebUser } from "@/lib/guards";
import { getPublicOrigin } from "@/lib/oidc";

export async function GET(request: Request) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const authorizeUrl = new URL("/api/auth/oidc/authorize", getPublicOrigin(request.url));
  authorizeUrl.searchParams.set("bind", "1");

  return Response.redirect(authorizeUrl.toString(), 302);
}

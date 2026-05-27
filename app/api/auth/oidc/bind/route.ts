export const dynamic = "force-dynamic";

import { ensureWebUser } from "@/lib/auth/guards";
import { requireFeature } from "@/lib/core/features";
import { getPublicOrigin } from "@/lib/auth/oidc";

export async function GET(request: Request) {
  const unavailable = requireFeature("oidc");
  if (unavailable) return unavailable;

  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const authorizeUrl = new URL("/api/auth/oidc/authorize", getPublicOrigin(request.url));
  authorizeUrl.searchParams.set("bind", "1");

  return Response.redirect(authorizeUrl.toString(), 302);
}

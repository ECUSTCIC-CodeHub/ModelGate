export const dynamic = "force-dynamic";

import { ensureWebUser } from "@/lib/auth/guards";
import { featureUnavailableMessage, modelGateFeatures } from "@/lib/core/features";
import { jsonError } from "@/lib/core/http";
import { getPublicOrigin } from "@/lib/auth/oidc";

export async function GET(request: Request) {
  if (!modelGateFeatures.oidc) {
    return jsonError(featureUnavailableMessage("OIDC"), 404);
  }

  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const authorizeUrl = new URL("/api/auth/oidc/authorize", getPublicOrigin(request.url));
  authorizeUrl.searchParams.set("bind", "1");

  return Response.redirect(authorizeUrl.toString(), 302);
}

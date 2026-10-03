export const dynamic = "force-dynamic";

import { ensureWebUser } from "@/lib/auth/guards";
import { requireFeature } from "@/lib/core/features";
import { jsonError } from "@/lib/core/http";
import { resolvePublicBaseUrl } from "@/lib/auth/oidc";

export async function GET(request: Request) {
  const unavailable = requireFeature("oidc");
  if (unavailable) return unavailable;

  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  // 该地址会交给浏览器跳转，不能用请求 Host 推导，否则可被伪造的 Host 指向任意站点
  const base = await resolvePublicBaseUrl();
  if (!base.ok) return jsonError(base.message, 400);

  const authorizeUrl = new URL("/api/auth/oidc/authorize", base.baseUrl);
  authorizeUrl.searchParams.set("bind", "1");

  return Response.redirect(authorizeUrl.toString(), 302);
}

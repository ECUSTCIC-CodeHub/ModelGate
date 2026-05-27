import { getGatewaySettings } from "@/lib/core/settings";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, x-api-key, anthropic-version, anthropic-beta",
  "Access-Control-Expose-Headers":
    "X-Quota-Limit-Requests-Remaining, X-Quota-Limit-Tokens-Remaining, X-Period-Quota-Requests-Remaining, X-Period-Quota-Tokens-Remaining, X-Period-Quota-Reset",
  "Access-Control-Max-Age": "86400",
};

export function isCorsEnabled(): boolean {
  try {
    return getGatewaySettings().cors_enabled === 1;
  } catch {
    return false;
  }
}

export function applyCorsHeaders(resp: Response): Response {
  if (!isCorsEnabled()) return resp;
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    resp.headers.set(k, v);
  }
  return resp;
}

export function handleCorsPreflight(): Response {
  if (!isCorsEnabled()) {
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export const dynamic = "force-dynamic";

import { jsonOk } from "@/lib/core/http";
import { getAuthStatus } from "@/lib/auth/auth-status";

export async function GET() {
  return jsonOk(getAuthStatus());
}

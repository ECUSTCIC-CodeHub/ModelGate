export const dynamic = "force-dynamic";

import { jsonOk } from "@/lib/http";
import { getAuthStatus } from "@/lib/auth-status";

export async function GET() {
  return jsonOk(getAuthStatus());
}

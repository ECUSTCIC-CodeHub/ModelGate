export const dynamic = "force-dynamic";

import { getGatewaySettings } from "@/lib/core/settings";
import { jsonOk } from "@/lib/core/http";

export function GET() {
  const settings = getGatewaySettings();
  return jsonOk({
    icp_filing_number: settings.icp_filing_number ?? "",
    public_security_filing_number: settings.public_security_filing_number ?? "",
  });
}

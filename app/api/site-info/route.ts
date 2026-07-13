export const dynamic = "force-dynamic";

import { getGatewaySettings } from "@/lib/core/settings";
import { jsonOk } from "@/lib/core/http";

export async function GET() {
  const settings = await getGatewaySettings();
  const repoName = (settings.repo_name ?? "").trim();
  const cnbUrl = repoName ? `https://cnb.cool/${repoName}/-/issues/new/choose` : "";
  const customUrl = (settings.feedback_url ?? "").trim();
  const template = customUrl || cnbUrl;
  const resolved = template.replace(/\{repo\}/g, repoName.replace(/\$/g, "$$"));
  const feedbackUrl = /^https?:\/\//i.test(resolved) ? resolved : "";
  return jsonOk({
    data: {
      icp_filing_number: settings.icp_filing_number ?? "",
      public_security_filing_number: settings.public_security_filing_number ?? "",
      feedback_url: feedbackUrl,
    },
  });
}

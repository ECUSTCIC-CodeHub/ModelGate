import { unstable_noStore } from "next/cache";
import { getGatewaySettings } from "@/lib/core/settings";

export function Footer() {
  unstable_noStore();
  const settings = getGatewaySettings();
  const icp = settings.icp_filing_number?.trim();
  const ps = settings.public_security_filing_number?.trim();

  if (!icp && !ps) return null;

  const recordCode = ps ? ps.replace(/\D/g, "") : "";

  return (
    <footer className="border-t border-[var(--color-border)] py-5 text-center text-xs text-[var(--color-foreground-muted)]">
      <div className="mx-auto flex flex-wrap items-center justify-center gap-x-4 gap-y-2 px-4">
        {icp ? (
          <a
            className="transition-colors hover:text-[var(--color-accent)]"
            href="https://beian.miit.gov.cn/"
            target="_blank"
            rel="noopener noreferrer"
          >
            {icp}
          </a>
        ) : null}
        {ps && recordCode ? (
          <a
            className="inline-flex items-center transition-colors hover:text-[var(--color-accent)]"
            style={{ height: 20, lineHeight: "20px" }}
            href={`http://www.beian.gov.cn/portal/registerSystemInfo?recordcode=${recordCode}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <img
              src="https://beian.mps.gov.cn/img/ghs.png"
              alt=""
              style={{ float: "left", marginRight: 4 }}
            />
            {ps}
          </a>
        ) : null}
      </div>
    </footer>
  );
}

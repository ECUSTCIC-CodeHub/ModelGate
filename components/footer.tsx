"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

interface SiteInfo {
  icp_filing_number: string;
  public_security_filing_number: string;
}

export function Footer() {
  const [info, setInfo] = useState<SiteInfo | null>(null);

  useEffect(() => {
    fetch("/api/site-info", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        const d = data?.data;
        if (d && typeof d === "object") {
          setInfo(d as SiteInfo);
        }
      })
      .catch(() => {});
  }, []);

  if (!info) return null;

  const icp = info.icp_filing_number?.trim();
  const ps = info.public_security_filing_number?.trim();

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
            <Image
              src="https://beian.mps.gov.cn/img/ghs.png"
              alt=""
              width={20}
              height={20}
              className="mr-1"
            />
            {ps}
          </a>
        ) : null}
      </div>
    </footer>
  );
}

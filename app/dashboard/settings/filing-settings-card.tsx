"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function FilingSettingsCard({
  icpFilingNumber,
  publicSecurityFilingNumber,
  setIcpFilingNumber,
  setPublicSecurityFilingNumber,
}: {
  icpFilingNumber: string;
  publicSecurityFilingNumber: string;
  setIcpFilingNumber: (value: string) => void;
  setPublicSecurityFilingNumber: (value: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="网站备案"
          description="配置网站底部展示的 ICP 备案号与公安联网备案号。留空则不展示。"
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-[var(--color-foreground)]">
            ICP 备案号
          </label>
          <Input
            placeholder="输入 ICP 备案号"
            value={icpFilingNumber}
            onChange={(e) => setIcpFilingNumber(e.target.value)}
            maxLength={200}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">
            填入后将链接至 https://beian.miit.gov.cn/
          </p>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-[var(--color-foreground)]">
            公安联网备案号
          </label>
          <Input
            placeholder="公安联网备案号"
            value={publicSecurityFilingNumber}
            onChange={(e) => setPublicSecurityFilingNumber(e.target.value)}
            maxLength={200}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">
            填入后将自动提取数字编码链接至公安联网备案查询页面，并附带国徽标识。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

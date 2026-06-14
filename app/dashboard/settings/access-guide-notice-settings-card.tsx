"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export function AccessGuideNoticeSettingsCard({
  accessGuideNotice,
  setAccessGuideNotice,
}: {
  accessGuideNotice: string;
  setAccessGuideNotice: (value: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="接入指南通知"
          description="在接入指南页面顶部展示的自定义内容，支持 Markdown 格式。留空则不展示。"
        />
      </CardHeader>
      <CardContent>
        <textarea
          className="flex min-h-40 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3 text-sm text-[var(--color-foreground)] shadow-[var(--shadow-inner-highlight)] placeholder:text-[var(--color-foreground-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20"
          placeholder={"支持 Markdown，例如：\n## 自动配置工具\n\n```bash\nnpx my-config-helper\n```"}
          value={accessGuideNotice}
          onChange={(e) => setAccessGuideNotice(e.target.value)}
          maxLength={10000}
        />
      </CardContent>
    </Card>
  );
}

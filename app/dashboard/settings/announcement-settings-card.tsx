"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export function AnnouncementSettingsCard({
  announcementContent,
  setAnnouncementContent,
}: {
  announcementContent: string;
  setAnnouncementContent: (value: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="系统公告"
          description="用户登录仪表盘后将弹窗展示公告内容，支持 Markdown 格式。留空则不展示。"
        />
      </CardHeader>
      <CardContent>
        <textarea
          className="flex min-h-40 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3 text-sm text-[var(--color-foreground)] shadow-[var(--shadow-inner-highlight)] placeholder:text-[var(--color-foreground-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20"
          placeholder={"支持 Markdown，例如：\n# 公告标题\n\n公告正文内容..."}
          value={announcementContent}
          onChange={(e) => setAnnouncementContent(e.target.value)}
          maxLength={5000}
        />
      </CardContent>
    </Card>
  );
}

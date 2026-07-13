"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function FeedbackSettingsCard({
  feedbackUrl,
  repoName,
  setFeedbackUrl,
  setRepoName,
}: {
  feedbackUrl: string;
  repoName: string;
  setFeedbackUrl: (value: string) => void;
  setRepoName: (value: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="问题反馈"
          description="配置侧边栏「问题反馈」跳转链接。留空则不展示。链接将以新窗口打开并附带 noreferrer。"
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-[var(--color-foreground)]">
            反馈链接
          </label>
          <Input
            placeholder="https://example.com/feedback"
            value={feedbackUrl}
            onChange={(e) => setFeedbackUrl(e.target.value)}
            maxLength={2000}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">
            不使用 CNB 时，直接填写完整反馈链接。
          </p>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-[var(--color-foreground)]">
            CNB 仓库路径
          </label>
          <Input
            placeholder="ecustcic/ModelGate"
            value={repoName}
            onChange={(e) => setRepoName(e.target.value)}
            maxLength={200}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">
            使用 CNB 的 Issue 时，直接填写仓库路径（如 ecustcic/ModelGate），将自动生成 https://cnb.cool/&lt;仓库路径&gt;/-/issues/new/choose，上方链接无需填写。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

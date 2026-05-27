"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildDisplayUrl } from "./settings-card-utils";

export function WebhookSettingsCard({
  publicBaseUrl,
  webhookSecret,
  setWebhookSecret,
  copyPublicUrl,
}: {
  publicBaseUrl: string;
  webhookSecret: string;
  setWebhookSecret: (value: string) => void;
  copyPublicUrl: (path: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="Webhook 回调"
          description="接收外部平台的用户变更回调，自动根据角色/标签匹配用户组。"
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>回调密钥</Label>
          <Input
            type="password"
            placeholder="Webhook Secret"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>回调地址</Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-[var(--color-surface-hover)] px-3 py-2 text-sm text-[var(--color-foreground-secondary)]">
              {buildDisplayUrl(publicBaseUrl, "/api/webhook")}
            </code>
            <Button type="button" variant="outline" size="sm" onClick={() => copyPublicUrl("/api/webhook")}>
              复制
            </Button>
          </div>
          <p className="text-xs text-[var(--color-foreground-muted)]">
            支持事件: user.role_change、user.tags_changed、user.identity_change。
            匹配规则使用各用户组的 Claim 表达式（role、tags 字段）。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

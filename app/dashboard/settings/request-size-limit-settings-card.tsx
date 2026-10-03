"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export function RequestSizeLimitSettingsCard({
  enabled,
  setEnabled,
}: {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="请求体上限"
          description="对网关各入口的请求体大小做限制，超过上限的请求直接返回 413。"
        />
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="request-size-limit">限制请求体大小</Label>
            <p className="text-xs text-[var(--color-foreground-muted)]">
              上限固定为 50MB，覆盖 OpenAI、Anthropic、Ollama 与透传入口。关闭后不再限制请求体大小，
              超大请求可能占用较多内存与上游额度，请仅在确有需要时关闭。
            </p>
          </div>
          <Switch id="request-size-limit" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </CardContent>
    </Card>
  );
}

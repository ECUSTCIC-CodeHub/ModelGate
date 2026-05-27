"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleRow } from "./settings-card-utils";

export function UpstreamSettingsCard({
  upstreamRetryEnabled,
  upstreamRetryMaxAttempts,
  circuitBreakerEnabled,
  setUpstreamRetryEnabled,
  setUpstreamRetryMaxAttempts,
  setCircuitBreakerEnabled,
}: {
  upstreamRetryEnabled: boolean;
  upstreamRetryMaxAttempts: number;
  circuitBreakerEnabled: boolean;
  setUpstreamRetryEnabled: (value: boolean) => void;
  setUpstreamRetryMaxAttempts: (value: number) => void;
  setCircuitBreakerEnabled: (value: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="上游重试策略"
          description="控制渠道异常时的自动切换行为。"
        />
      </CardHeader>
      <CardContent className="space-y-5">
        <ToggleRow
          title="开启自动切换"
          description="命中 401、429 或 5xx 时尝试其他渠道。"
          checked={upstreamRetryEnabled}
          onCheckedChange={setUpstreamRetryEnabled}
        />
        <ToggleRow
          title="上游熔断"
          description="连续失败 3 次后暂停该渠道 15 秒，防止雪崩。关闭后所有渠道始终可用。"
          checked={circuitBreakerEnabled}
          onCheckedChange={setCircuitBreakerEnabled}
        />
        <div className="space-y-2">
          <Label>最大路由尝试次数</Label>
          <Input
            type="number"
            min={1}
            max={10}
            value={upstreamRetryMaxAttempts}
            onChange={(e) => setUpstreamRetryMaxAttempts(Number(e.target.value))}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">默认 3，建议不要超过 5，避免上游回退过慢。</p>
        </div>
      </CardContent>
    </Card>
  );
}

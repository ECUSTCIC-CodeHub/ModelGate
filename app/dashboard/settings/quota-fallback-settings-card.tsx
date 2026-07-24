"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleRow } from "./settings-card-utils";

export function QuotaFallbackSettingsCard({
  quotaFallbackEnabled,
  quotaFallbackAlias,
  setQuotaFallbackEnabled,
  setQuotaFallbackAlias,
}: {
  quotaFallbackEnabled: boolean;
  quotaFallbackAlias: string;
  setQuotaFallbackEnabled: (value: boolean) => void;
  setQuotaFallbackAlias: (value: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="达到限额后自动路由"
          description="模型独立配额超限时切换到其他可用模型；用户配额或速率限制超限时，仅切换到不计入用户配额的模型（独立配额或不计费计费模式）。仅对话类协议生效，图片生成协议不接入。"
        />
      </CardHeader>
      <CardContent className="space-y-5">
        <ToggleRow
          title="开启限额自动路由"
          description="达到限额时按权重逐个尝试其他已启用且当前用户可见的模型，直到命中可用的为止。"
          checked={quotaFallbackEnabled}
          onCheckedChange={setQuotaFallbackEnabled}
        />
        <div className="space-y-2">
          <Label>指定路由模型别名</Label>
          <Input
            value={quotaFallbackAlias}
            placeholder="留空则按权重自动挑选已启用且当前用户可见的模型"
            onChange={(e) => setQuotaFallbackAlias(e.target.value)}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">
            填写后将优先路由到该别名对应的模型；留空时从已启用模型中按权重自动分配。用户配额或速率超限时，建议指定计费模式为「独立配额」或可不计费的模型，否则仍会被用户限额拦截。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

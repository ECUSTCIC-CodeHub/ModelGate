"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleRow } from "./settings-card-utils";

export function VisionFallbackSettingsCard({
  visionFallbackEnabled,
  visionFallbackAlias,
  setVisionFallbackEnabled,
  setVisionFallbackAlias,
}: {
  visionFallbackEnabled: boolean;
  visionFallbackAlias: string;
  setVisionFallbackEnabled: (value: boolean) => void;
  setVisionFallbackAlias: (value: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="图片自动路由到识图模型"
          description="用户向不支持识图的模型发送图片时，自动改路由到支持识图的模型。"
        />
      </CardHeader>
      <CardContent className="space-y-5">
        <ToggleRow
          title="开启图片自动路由"
          description="请求包含图片且目标模型未标记支持识图时，自动切换到识图模型。"
          checked={visionFallbackEnabled}
          onCheckedChange={setVisionFallbackEnabled}
        />
        <div className="space-y-2">
          <Label>指定识图模型别名</Label>
          <Input
            value={visionFallbackAlias}
            placeholder="留空则自动挑选任意已启用的识图模型"
            onChange={(e) => setVisionFallbackAlias(e.target.value)}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">
            填写后将优先路由到该别名对应的模型；留空时从已启用且标记「支持识图」的模型中自动选择。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

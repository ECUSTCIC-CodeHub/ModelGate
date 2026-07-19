"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleRow } from "./settings-card-utils";

export function ModelFallbackSettingsCard({
  modelFallbackEnabled,
  modelFallbackAlias,
  setModelFallbackEnabled,
  setModelFallbackAlias,
}: {
  modelFallbackEnabled: boolean;
  modelFallbackAlias: string;
  setModelFallbackEnabled: (value: boolean) => void;
  setModelFallbackAlias: (value: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="请求模型不可用时自动替补"
          description="用户请求的模型不存在或被禁用时，自动路由到其他模型。"
        />
      </CardHeader>
      <CardContent className="space-y-5">
        <ToggleRow
          title="开启模型自动替补"
          description="用户请求的模型不存在或被禁用时，自动切换到替补模型。"
          checked={modelFallbackEnabled}
          onCheckedChange={setModelFallbackEnabled}
        />
        <div className="space-y-2">
          <Label>指定替补模型别名</Label>
          <Input
            value={modelFallbackAlias}
            placeholder="留空则按权重自动挑选已启用且当前用户可见的模型"
            onChange={(e) => setModelFallbackAlias(e.target.value)}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">
            填写后将优先路由到该别名对应的模型；留空时从已启用模型中按权重自动分配。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

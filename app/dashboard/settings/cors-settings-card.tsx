"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ToggleRow } from "./settings-card-utils";

export function CorsSettingsCard({
  corsEnabled,
  setCorsEnabled,
}: {
  corsEnabled: boolean;
  setCorsEnabled: (value: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="跨域访问 (CORS)"
          description="允许浏览器端从任意来源调用网关 API。开启后将对所有 /api/v1/* 和 /api/ollama/* 接口返回 Access-Control-Allow-Origin: *。"
        />
      </CardHeader>
      <CardContent>
        <ToggleRow
          title="允许所有来源跨域"
          description="关闭时浏览器跨域请求会被拦截。仅在需要从前端直连网关时开启。"
          checked={corsEnabled}
          onCheckedChange={setCorsEnabled}
        />
      </CardContent>
    </Card>
  );
}

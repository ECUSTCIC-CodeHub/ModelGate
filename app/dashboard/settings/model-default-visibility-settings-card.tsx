"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ToggleRow } from "./settings-card-utils";

export function ModelDefaultVisibilitySettingsCard({
  defaultModelIsPublic,
  setDefaultModelIsPublic,
}: {
  defaultModelIsPublic: boolean;
  setDefaultModelIsPublic: (value: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="新增模型默认公开"
          description="控制新增模型的默认可见性；关闭后新增模型默认仅对授权用户可见（白名单）。"
        />
      </CardHeader>
      <CardContent>
        <ToggleRow
          title="新增模型默认公开"
          description="开启后新创建的模型对所有非管理员用户可见；关闭后仅被显式授权的用户/用户组可访问。"
          checked={defaultModelIsPublic}
          onCheckedChange={setDefaultModelIsPublic}
        />
      </CardContent>
    </Card>
  );
}

"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ToggleRow } from "./settings-card-utils";

export function OverviewScopeSettingsCard({
  overviewGlobal,
  setOverviewGlobal,
}: {
  overviewGlobal: boolean;
  setOverviewGlobal: (value: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="概览统计范围"
          description="控制普通用户首页概览展示的数据范围。管理员始终看全局。"
        />
      </CardHeader>
      <CardContent className="space-y-5">
        <ToggleRow
          title="普通用户查看全局概览"
          description="开启后，普通用户首页概览展示站点运行全貌（全局请求、Token、Top 模型/渠道等）；关闭则仅展示该用户自己的统计。密钥数量始终按当前用户隔离。"
          checked={overviewGlobal}
          onCheckedChange={setOverviewGlobal}
        />
      </CardContent>
    </Card>
  );
}

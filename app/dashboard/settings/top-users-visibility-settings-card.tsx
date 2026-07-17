"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ToggleRow } from "./settings-card-utils";

export function TopUsersVisibilitySettingsCard({
  topUsersVisible,
  setTopUsersVisible,
}: {
  topUsersVisible: boolean;
  setTopUsersVisible: (value: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="用户排行榜可见性"
          description="控制普通用户是否能在首页看到 Top 用户排行。管理员始终可见。"
        />
      </CardHeader>
      <CardContent className="space-y-5">
        <ToggleRow
          title="允许普通用户查看用户排行榜"
          description="开启后，普通用户可在首页看到按 Token 消耗排序的 Top 用户；关闭则仅管理员可见。"
          checked={topUsersVisible}
          onCheckedChange={setTopUsersVisible}
        />
      </CardContent>
    </Card>
  );
}

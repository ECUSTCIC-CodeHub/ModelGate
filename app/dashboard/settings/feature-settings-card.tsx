"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ToggleRow } from "./settings-card-utils";

export function FeatureSettingsCard({
  redeemCodeEnabled,
  setRedeemCodeEnabled,
}: {
  redeemCodeEnabled: boolean;
  setRedeemCodeEnabled: (value: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="功能开关"
          description="控制可选的业务模块是否对全体用户开放。关闭后相关入口从菜单隐藏，接口返回 404。"
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <ToggleRow
          title="兑换码"
          description="开启后用户可在「兑换码」页输入兑换码，获取限定渠道与模型的定向额度；管理员可在「兑换码管理」页批量生成与编辑。关闭不影响已发放额度的数据，重新开启即恢复。"
          checked={redeemCodeEnabled}
          onCheckedChange={setRedeemCodeEnabled}
        />
      </CardContent>
    </Card>
  );
}

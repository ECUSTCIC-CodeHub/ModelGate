"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LogRetentionSettingsCard({
  days,
  setDays,
}: {
  days: number;
  setDays: (value: number) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="日志保留"
          description="请求日志超过保留天数后自动清理，避免日志表无限膨胀。默认 0 表示不清理；设为正数启用。"
        />
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <Label>保留天数</Label>
          <Input
            type="number"
            min={0}
            max={3650}
            value={days}
            onChange={(e) => setDays(Math.max(0, Math.min(3650, Number(e.target.value) || 0)))}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">
            清理任务每 6 小时执行一次，分批删除超期日志；0 表示永久保留。
          </p>
          <p className="text-xs text-[var(--color-foreground-muted)]">
            保留天数仅影响日志明细与首页“活跃用户 / 平均延迟 / 平均输出速度 / 近 N 天失败请求”等窗口指标的统计范围；总请求数、总 Token 等累计指标不受影响。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

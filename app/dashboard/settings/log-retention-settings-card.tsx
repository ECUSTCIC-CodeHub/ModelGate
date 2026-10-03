"use client";

import { useState } from "react";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/dashboard/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { authedFetch } from "@/lib/auth/client-auth";
import { getApiMessage } from "@/lib/shared/api-message";

export function LogRetentionSettingsCard({
  days,
  setDays,
  autoCleanupEnabled,
  setAutoCleanupEnabled,
}: {
  days: number;
  setDays: (value: number) => void;
  autoCleanupEnabled: boolean;
  setAutoCleanupEnabled: (value: boolean) => void;
}) {
  const { toast } = useToast();
  const [cleaning, setCleaning] = useState(false);

  async function runCleanup() {
    if (days <= 0) return;
    setCleaning(true);
    try {
      // 显式传表单里的天数：接口无参时用「已保存值」，与弹窗承诺的范围可能不一致
      // （改了天数但没保存时，会出现「提示不能清理却真删了数据」的反直觉行为）
      const response = await authedFetch("/api/admin/logs/cleanup", {
        method: "POST",
        body: JSON.stringify({ days }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        toast({ variant: "error", description: getApiMessage(data, "清理日志失败。") });
        return;
      }
      const deleted = (data?.data?.deleted ?? 0) as number;
      toast({ variant: "success", description: `已清理 ${deleted} 条日志。` });
    } finally {
      setCleaning(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="日志保留"
          description="请求日志超过保留天数后自动清理，避免日志表无限膨胀。默认 0 表示不清理；设为正数启用。"
        />
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
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
              0 表示永久保留。保留天数同时决定下方「立即清理」的影响范围。
            </p>
            <p className="text-xs text-[var(--color-foreground-muted)]">
              保留天数仅影响日志明细与首页“活跃用户 / 平均延迟 / 平均输出速度 / 近 N 天失败请求”等窗口指标的统计范围；总请求数、总 Token 等累计指标不受影响。
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Checkbox
              checked={autoCleanupEnabled}
              onCheckedChange={(checked) => setAutoCleanupEnabled(checked === true)}
            />
            <div>
              <Label>定时自动清理</Label>
              <p className="text-xs text-[var(--color-foreground-muted)]">
                开启后每 6 小时按保留天数自动清理；关闭则只保留「立即清理」的手动入口。开启前需先把保留天数设为大于 0。
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <ConfirmDialog
              trigger={
                <Button type="button" variant="outline" disabled={cleaning || days <= 0}>
                  {cleaning ? "清理中…" : "立即清理"}
                </Button>
              }
              title="立即按保留天数清理日志？"
              description={
                days > 0
                  ? `将删除 ${days} 天前的请求日志与邮件发送日志，此操作不可撤销。`
                  : "当前保留天数为 0。请先设置一个大于 0 的保留天数，否则无法清理。"
              }
              onConfirm={() => void runCleanup()}
            />
            <p className="text-xs text-[var(--color-foreground-muted)]">
              {days > 0 ? `将清理 ${days} 天前的日志。` : "保留天数为 0，无法立即清理。"}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clampStatusLightHours, STATUS_LIGHT_MAX_HOURS } from "@/lib/shared/utils";

export function ModelStatusLightSettingsCard({
  hours1,
  setHours1,
  hours2,
  setHours2,
  hours3,
  setHours3,
}: {
  hours1: number;
  setHours1: (value: number) => void;
  hours2: number;
  setHours2: (value: number) => void;
  hours3: number;
  setHours3: (value: number) => void;
}) {
  function clamp(value: number) {
    return clampStatusLightHours(value, 1);
  }

  const lights = [
    { label: "状态灯 1", value: hours1, set: setHours1, desc: "最近一档成功率统计时长" },
    { label: "状态灯 2", value: hours2, set: setHours2, desc: "第二档成功率统计时长" },
    { label: "状态灯 3", value: hours3, set: setHours3, desc: "第三档成功率统计时长" },
  ];

  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="模型成功率状态灯"
          description="接入指南模型列表为每个模型展示三盏成功率状态灯，分别统计最近时长的成功率。默认 1 小时、2 小时、3 小时，可分别调整。"
        />
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-3">
          {lights.map((l) => (
            <div key={l.label} className="space-y-2">
              <Label>{l.label}（小时）</Label>
              <Input
                type="number"
                min={1}
                max={STATUS_LIGHT_MAX_HOURS}
                value={l.value}
                onChange={(e) => l.set(clamp(Number(e.target.value)))}
              />
              <p className="text-xs text-[var(--color-foreground-muted)]">{l.desc}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-[var(--color-foreground-muted)]">
          状态灯按统计时长从小到大依次排列：左起第一盏为最短时长。修改后最长 30 秒内在模型列表生效。
        </p>
      </CardContent>
    </Card>
  );
}

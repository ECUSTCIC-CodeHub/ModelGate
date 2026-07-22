"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ModelBrandGroupsEditor, type BrandGroupDraft, brandGroupsToJson, jsonToBrandGroups } from "@/components/model-brand-groups-editor";

export function ModelBrandGroupsSettingsCard({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="模型品牌分组"
          description="按模型 ID 前缀归组，用于模型列表页按品牌筛选展示。"
        />
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <Label>品牌组规则</Label>
          <ModelBrandGroupsEditor
            groups={jsonToBrandGroups(value)}
            onChange={(groups: BrandGroupDraft[]) => onChange(brandGroupsToJson(groups))}
          />
        </div>
      </CardContent>
    </Card>
  );
}

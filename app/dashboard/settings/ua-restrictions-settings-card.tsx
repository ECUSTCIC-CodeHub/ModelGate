"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { UaRestrictionsEditor, type UaRestrictionRuleDraft, rulesToJson, jsonToRules } from "@/components/ua-restrictions-editor";

export function UaRestrictionsSettingsCard({
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
          title="全站 User-Agent 限制"
          description="对所有请求生效，优先级高于渠道与模型限制。命中拒绝规则立即拦截。"
        />
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <Label>限制规则</Label>
          <UaRestrictionsEditor
            rules={jsonToRules(value)}
            onChange={(rules: UaRestrictionRuleDraft[]) => onChange(rulesToJson(rules))}
          />
        </div>
      </CardContent>
    </Card>
  );
}

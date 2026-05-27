"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ToggleRow } from "./settings-card-utils";

export function LoginSettingsCard({
  oidcFeatureEnabled,
  passwordLoginEnabled,
  registrationEnabled,
  setPasswordLoginEnabled,
  setRegistrationEnabled,
}: {
  oidcFeatureEnabled: boolean;
  passwordLoginEnabled: boolean;
  registrationEnabled: boolean;
  setPasswordLoginEnabled: (value: boolean) => void;
  setRegistrationEnabled: (value: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="登录与注册"
          description="控制账号密码登录入口与注册开关。限速与配额请前往「用户组」配置。"
        />
      </CardHeader>
      <CardContent className="space-y-5">
        <ToggleRow
          title="允许账号密码登录"
          description={oidcFeatureEnabled ? "关闭后仅支持 OIDC 登录。请确保 OIDC 已配置且有管理员已绑定。" : "当前构建不包含 OIDC，账号密码登录必须保留。"}
          checked={passwordLoginEnabled}
          onCheckedChange={setPasswordLoginEnabled}
          disabled={!oidcFeatureEnabled}
        />
        <ToggleRow
          title="允许账号密码注册"
          description={oidcFeatureEnabled ? "关闭后仅管理员可创建用户，OIDC 自动注册不受影响。" : "关闭后仅管理员可创建用户。"}
          checked={registrationEnabled}
          onCheckedChange={setRegistrationEnabled}
        />
      </CardContent>
    </Card>
  );
}

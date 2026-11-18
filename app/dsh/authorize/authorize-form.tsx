"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * /dsh/authorize 的确认按钮。确认动作是 POST（会新建密钥，不可幂等），
 * 所以页面用一份隐藏表单提交。提交后服务端 303 到 GET 成功页展示 8 位一次性兑换码：DSH 主路径
 * 用「前往自动接入」把该码回传本机回调换取密钥；若回调失败，用户可复制页面上的
 * 码粘贴到 DSH 卡片完成备用兑换。明文密钥不经过浏览器。
 */
export function AuthorizeForm({
  port,
  session,
  username,
}: {
  port: string;
  session: string | null;
  username: string;
}) {
  const [loading, setLoading] = useState(false);

  const handleSubmit = () => {
    setLoading(true);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>登录到 DeepSeek Harness</CardTitle>
        <CardDescription>
          当前已登录账号 <strong className="font-medium text-[var(--color-foreground)]">{username}</strong>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-6 text-[var(--color-foreground-muted)]">
          确认后本页会展示一枚 8 位一次性兑换码；DSH 用它换取本次新建的网关密钥。
          若自动接入未成功，可复制该码到 DSH 卡片完成接入。
        </p>
        <form method="post" action="/api/user/dsh/authorize-confirm" onSubmit={handleSubmit}>
          <input type="hidden" name="port" value={port} />
          {session ? <input type="hidden" name="session" value={session} /> : null}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "正在确认…" : "确认登录到 DSH"}
          </Button>
        </form>
        <p className="text-xs leading-5 text-[var(--color-foreground-subtle)]">
          明文密钥不会显示在此页面，只由 DSH 用兑换码取回。
        </p>
      </CardContent>
    </Card>
  );
}

"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleRow } from "./settings-card-utils";

export function UpstreamSettingsCard({
  upstreamRetryEnabled,
  upstreamRetryMaxAttempts,
  upstreamRetrySameChannel,
  upstreamRetryStatusCodes,
  circuitBreakerEnabled,
  upstreamStrictPriority,
  setUpstreamRetryEnabled,
  setUpstreamRetryMaxAttempts,
  setUpstreamRetrySameChannel,
  setUpstreamRetryStatusCodes,
  setCircuitBreakerEnabled,
  setUpstreamStrictPriority,
}: {
  upstreamRetryEnabled: boolean;
  upstreamRetryMaxAttempts: number;
  upstreamRetrySameChannel: boolean;
  upstreamRetryStatusCodes: string;
  circuitBreakerEnabled: boolean;
  upstreamStrictPriority: boolean;
  setUpstreamRetryEnabled: (value: boolean) => void;
  setUpstreamRetryMaxAttempts: (value: number) => void;
  setUpstreamRetrySameChannel: (value: boolean) => void;
  setUpstreamRetryStatusCodes: (value: string) => void;
  setCircuitBreakerEnabled: (value: boolean) => void;
  setUpstreamStrictPriority: (value: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="上游重试策略"
          description="控制渠道异常时的自动切换行为。渠道配额耗尽、并发已满或已熔断时始终会自动切到其他候选渠道（同别名的低权重渠道也会被使用），不受此处开关限制。"
        />
      </CardHeader>
      <CardContent className="space-y-5">
        <ToggleRow
          title="开启自动切换"
          description="上游返回下列状态码时尝试其他渠道。关闭后上游报错不再换渠道。"
          checked={upstreamRetryEnabled}
          onCheckedChange={setUpstreamRetryEnabled}
        />
        <div className="space-y-2">
          <Label>触发换渠道的状态码</Label>
          <Input
            value={upstreamRetryStatusCodes}
            placeholder="401,402,403,429"
            onChange={(e) => setUpstreamRetryStatusCodes(e.target.value)}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">
            用逗号分隔，支持 400-599；留空表示沿用内置默认（401、402、403、429 与全部 5xx）。网关只按状态码判断是否换渠道，不解析响应报文内容。单个渠道可在「渠道管理」里单独覆盖。
          </p>
        </div>
        <ToggleRow
          title="同渠道重试"
          description="没有其他候选渠道时，429 仍对当前渠道重试。关闭则 429 直接返回。注意这不会阻止换渠道，只影响候选耗尽后的最后一次重试。"
          checked={upstreamRetrySameChannel}
          onCheckedChange={setUpstreamRetrySameChannel}
        />
        <ToggleRow
          title="上游熔断"
          description="连续失败 3 次后暂停该渠道 15 秒，防止雪崩；被熔断的渠道会被跳过并自动使用其他候选渠道。关闭后所有渠道始终可用。"
          checked={circuitBreakerEnabled}
          onCheckedChange={setCircuitBreakerEnabled}
        />
        <ToggleRow
          title="严格优先级"
          description="仅按权重排序，不因并发或延迟自动降级到低权重渠道。高权重渠道未失败则不切换。"
          checked={upstreamStrictPriority}
          onCheckedChange={setUpstreamStrictPriority}
        />
        <div className="space-y-2">
          <Label>最大路由尝试次数</Label>
          <Input
            type="number"
            min={1}
            max={10}
            value={upstreamRetryMaxAttempts}
            onChange={(e) => { const v = Number(e.target.value); setUpstreamRetryMaxAttempts(v < 1 || Number.isNaN(v) ? 1 : v); }}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">
            默认 3，建议不要超过 5，避免上游回退过慢。该次数只限制「真正打到上游的次数」：渠道配额不足、并发已满、熔断这类预检失败不消耗次数，会继续尝试下一个候选渠道。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

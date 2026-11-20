"use client";

// 生效倍率后面跟的小标：说明「显示的数值不是配置值」，因为命中了分时档。
// 不抢主体字号，只在需要解释差异时才出现。
export function EffectiveScheduleTag() {
  return (
    <span
      className="ml-1 text-[10px] font-normal text-[var(--color-foreground-muted)]"
      title="当前时段命中分时档，显示的是实际生效倍率；基础倍率见下方提示"
    >
      分时
    </span>
  );
}

// 来源按维度说：模型档只填了 token 时，request 仍然是渠道档给的，笼统写「模型级」会指错地方。
// 只在命中的维度上点出来源，两侧维度都命中同一层时合并成一句话，别把提示写成流水账。
export function describeScheduleSource(fromModel: { token: boolean; request: boolean }): string {
  const { token, request } = fromModel;
  if (token && request) return "模型级";
  if (!token && !request) return "渠道级";
  return token ? "Token 来自模型级、请求来自渠道级" : "Token 来自渠道级、请求来自模型级";
}

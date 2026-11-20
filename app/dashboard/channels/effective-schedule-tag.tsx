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
// 只在命中的维度上点出来源，两侧都命中同一层时合并成一句话；两侧都没命中模型档时说的是「落在渠道档或基础倍率」，
// 不能写成「命中渠道级」——渠道档同样可以留空该维度，那时生效值就是基础倍率。
export function describeScheduleSource(fromModel: { token: boolean; request: boolean }): string {
  const { token, request } = fromModel;
  if (token && request) return "模型级分时档";
  if (token) return "模型级分时档（请求倍率来自渠道级分时档或基础倍率）";
  if (request) return "模型级分时档（Token 倍率来自渠道级分时档或基础倍率）";
  return "渠道级分时档或基础倍率";
}

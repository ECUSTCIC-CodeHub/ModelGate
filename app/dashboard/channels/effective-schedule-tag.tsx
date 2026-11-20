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

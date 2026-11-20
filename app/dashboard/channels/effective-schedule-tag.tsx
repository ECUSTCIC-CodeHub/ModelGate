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

// 单独一维的来源小标。明细行按维度标记，值被覆盖了就说清是哪一层改的价：
// 模型档生效标「模型分时」，只有渠道档命中则标更弱的「渠道分时」——两种都不会在值等于基础值时漏标。
export function ScheduleSourceTag({ fromModel, scheduled }: { fromModel: boolean; scheduled: boolean }) {
  if (!scheduled) return null;
  return (
    <span
      className={
        fromModel
          ? "ml-1 text-[10px] font-normal text-[var(--color-accent)]"
          : "ml-1 text-[10px] font-normal text-[var(--color-foreground-muted)]"
      }
      title={
        fromModel
          ? "当前时段该维度由这个模型的模型级分时档覆盖"
          : "当前时段该维度由渠道级分时档覆盖；基础倍率见下方提示"
      }
    >
      {fromModel ? "模型分时" : "渠道分时"}
    </span>
  );
}

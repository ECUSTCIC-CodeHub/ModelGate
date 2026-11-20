"use client";

// 单独一维的来源小标。明细行与卡片都按维度标记，值被覆盖了就说清是哪一层改的价：
// 模型档生效标「模型分时」，只有渠道档命中则标更弱的「渠道分时」。
// 两种都不靠比对基础倍率判断，所以渠道档恰好配成基础倍率时仍能标出。
// 文案不提「下方」「上方」：列表行与卡片的基础倍率位置不同，小标不跟着布局走。
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
          ? "当前时段该维度由这个模型的模型级分时档覆盖，显示的是实际生效倍率"
          : "当前时段该维度由渠道级分时档覆盖，显示的是实际生效倍率"
      }
    >
      {fromModel ? "模型分时" : "渠道分时"}
    </span>
  );
}

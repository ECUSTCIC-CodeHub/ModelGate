import type { RoutedModel } from "@/lib/gateway/router";

// 候选遍历的兜底上界：按「实际访问到的候选数」计数，只在真的取到候选时递增。
// 它与重试预算各管一段：达到上界只是「不再继续拉新候选」，已取出的候选仍按正常流程处理，
// 因此既不会抢重试预算的退出条件，也不会丢弃候选或截断 sameChannelRetry。
export const MAX_CANDIDATE_VISITS = 512;

export type CandidateShiftResult =
  | { type: "candidate"; route: RoutedModel; limitReached: boolean }
  | { type: "exhausted" };

type CandidateQueueOptions = {
  // 按当前排除集合拉取候选。排除集合（渠道 / 模型）都可能改变 listModelRoutes 的
  // 「精确别名优先、无精确候选才回退 *」语义，因此两者变化都要能触发重查。
  load: (exclusions: { excludeChannelIds: number[]; excludeModelIds: number[] }) => Promise<RoutedModel[]>;
  maxVisits?: number;
};

/**
 * 候选遍历状态机：负责「取下一个未被排除的候选」「记账后失效候选缓存」「访问上界兜底」三件事。
 * 记账只维护排除集合，不关心日志口径（attempted / skipped 由调用方维护）。
 *
 * 缓存策略：排除集合变化时先只标记脏，在内存里继续过滤当前缓冲；
 * 只有缓冲被消费空后才真正重查一次，避免热路径上「每排除一个候选就重查一次」的查询放大。
 */
export function createCandidateQueue({ load, maxVisits = MAX_CANDIDATE_VISITS }: CandidateQueueOptions) {
  const consumedChannelIds = new Set<number>();
  const excludedModelIds = new Set<number>();
  let buffered: RoutedModel[] = [];
  let loaded = false;
  let dirty = false;
  let visited = 0;
  // 达到上界后不再继续拉新候选，但已取出的候选仍返回给调用方正常处理。
  let limitReached = false;

  const loadCandidates = async () => {
    buffered = await load({
      excludeChannelIds: [...consumedChannelIds],
      excludeModelIds: [...excludedModelIds],
    });
    loaded = true;
    dirty = false;
  };

  const takeNext = () => {
    for (;;) {
      const next = buffered.shift();
      if (!next) return undefined;
      if (excludedModelIds.has(next.model.id)) continue;
      if (consumedChannelIds.has(next.channel.id)) continue;
      return next;
    }
  };

  return {
    // 消费下一个候选。达到上界时仍返回当前候选（标记 limitReached），下一轮不再拉新候选；
    // 已取出的候选不会被丢弃，调用方也不会因此错过 sameChannelRetry。
    async shift(): Promise<CandidateShiftResult> {
      if (limitReached) return { type: "exhausted" };
      if (!loaded) await loadCandidates();
      let route = takeNext();
      // 缓冲被过滤空且排除集合已变：重查一次，重新评估「精确别名 => * 回退」，仍空才算耗尽。
      if (!route && dirty) {
        await loadCandidates();
        route = takeNext();
      }
      if (!route) return { type: "exhausted" };
      visited += 1;
      if (visited > maxVisits) {
        limitReached = true;
        return { type: "candidate", route, limitReached: true };
      }
      return { type: "candidate", route, limitReached: false };
    },
    // 渠道被消费（预检跳过或真正请求）：计入排除集合并标记缓存脏。
    consumeChannel(channelId: number) {
      consumedChannelIds.add(channelId);
      dirty = true;
    },
    // 模型实例被排除：计入排除集合并标记缓存脏（脏标记只在缓冲耗尽后触发重查）。
    excludeModel(modelId: number) {
      excludedModelIds.add(modelId);
      dirty = true;
    },
  };
}

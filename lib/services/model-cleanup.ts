export type CleanupCandidate = {
  id: number;
  alias: string;
  real_model: string;
  enabled: number;
};

export type StaleModel = CleanupCandidate & {
  alias_match: boolean;
};

export type CleanupDiff = {
  stale: StaleModel[];
  kept: number;
  skippedWildcard: number;
  missingUpstream: string[];
};

function normalizeModelName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function isWildcardModel(model: CleanupCandidate): boolean {
  return model.alias.trim() === "*" || model.real_model.includes("*");
}

// 判定只看 real_model：网关发给上游的是它，alias 命中上游不能说明这条映射打得通。
// alias_match 仅用于提示管理员别名与真实模型不一致。
export function diffChannelModels(
  channelModels: CleanupCandidate[],
  upstreamIds: string[],
): CleanupDiff {
  const upstreamByKey = new Map<string, string>();
  for (const id of upstreamIds) {
    const key = normalizeModelName(id);
    if (key && !upstreamByKey.has(key)) upstreamByKey.set(key, id.trim());
  }

  const localKeys = new Set<string>();
  const stale: StaleModel[] = [];
  let kept = 0;
  let skippedWildcard = 0;

  for (const model of channelModels) {
    if (isWildcardModel(model)) {
      skippedWildcard += 1;
      continue;
    }

    const realKey = normalizeModelName(model.real_model);
    const aliasKey = normalizeModelName(model.alias);
    if (realKey) localKeys.add(realKey);
    if (aliasKey) localKeys.add(aliasKey);

    if (upstreamByKey.has(realKey)) {
      kept += 1;
      continue;
    }
    stale.push({ ...model, alias_match: aliasKey !== "" && upstreamByKey.has(aliasKey) });
  }

  const missingUpstream = [...upstreamByKey.entries()]
    .filter(([key]) => !localKeys.has(key))
    .map(([, original]) => original)
    .sort();

  return { stale, kept, skippedWildcard, missingUpstream };
}

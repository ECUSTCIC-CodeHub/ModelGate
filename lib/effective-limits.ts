import { gatewayDb, type DbGroup, type DbUser } from "@/lib/db";

export type EffectiveLimits = {
  qps: number;
  rpm: number;
  tpm: number;
  quota_requests: number | null;
  quota_tokens: number | null;
};

function pickRate(userVal: number, groupVal: number): number {
  if (userVal >= 0) return userVal;
  if (groupVal >= 0) return groupVal;
  return -1;
}

function pickQuota(userVal: number | null, groupVal: number | null): number | null {
  if (userVal !== null) return userVal;
  if (groupVal !== null) return groupVal;
  return null;
}

export function getUserGroup(groupId: number | null): DbGroup | null {
  if (groupId === null) return null;
  const group = gatewayDb
    .prepare("SELECT * FROM groups WHERE id = ? AND enabled = 1 AND deleted_at IS NULL")
    .get(groupId) as DbGroup | undefined;
  return group ?? null;
}

export function getEffectiveLimits(user: DbUser): EffectiveLimits {
  const group = getUserGroup(user.group_id);

  return {
    qps: pickRate(user.qps, group?.qps ?? -1),
    rpm: pickRate(user.rpm, group?.rpm ?? -1),
    tpm: pickRate(user.tpm, group?.tpm ?? -1),
    quota_requests: pickQuota(user.quota_requests, group?.quota_requests ?? null),
    quota_tokens: pickQuota(user.quota_tokens, group?.quota_tokens ?? null),
  };
}

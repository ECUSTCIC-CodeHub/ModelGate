import { gatewayDb, type DbUser } from "@/lib/core/db";
import { getUserAllowedChannelIds } from "@/lib/gateway/channel-access";
import { getUserGroup } from "@/lib/gateway/effective-limits";

export function parseAllowedModelAliases(raw: string | null | undefined) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function stringifyAllowedModelAliases(aliases: string[]) {
  const normalized = [...new Set(aliases.map((item) => item.trim()).filter(Boolean))].sort();
  return JSON.stringify(normalized);
}

export function getEffectiveAllowedAliases(user: Pick<DbUser, "group_id" | "allowed_model_aliases">): string[] {
  const userAliases = parseAllowedModelAliases(user.allowed_model_aliases);
  const group = getUserGroup(user.group_id ?? null);
  if (!group) return userAliases;
  const groupAliases = parseAllowedModelAliases(group.allowed_model_aliases);
  return [...new Set([...userAliases, ...groupAliases])];
}

const modelPublicByAliasStmt = gatewayDb.prepare(
  `SELECT is_public
   FROM models
   WHERE alias = ? AND enabled = 1 AND deleted_at IS NULL
   LIMIT 1`,
);

const enabledModelAliasStmt = gatewayDb.prepare(
  `SELECT 1
   FROM models m
   JOIN channels c ON c.id = m.channel_id
   WHERE m.alias = ?
     AND m.enabled = 1
     AND c.enabled = 1
     AND m.deleted_at IS NULL
     AND c.deleted_at IS NULL
   LIMIT 1`,
);

const accessibleModelRowsStmt = gatewayDb.prepare(
  `SELECT m.alias, m.is_public, m.created_at, m.token_multiplier, m.request_multiplier,
          m.weight AS model_weight,
          c.id AS channel_id, c.name AS channel_name, c.weight AS channel_weight
   FROM models m
   JOIN channels c ON c.id = m.channel_id
   WHERE m.enabled = 1
     AND c.enabled = 1
     AND m.deleted_at IS NULL
     AND c.deleted_at IS NULL
     AND m.alias != '*'
   ORDER BY m.alias ASC, m.id ASC`,
);

export function canUserAccessModelAlias(user: Pick<DbUser, "role" | "group_id" | "allowed_model_aliases">, alias: string) {
  if (user.role === "admin") return true;

  const model = modelPublicByAliasStmt.get(alias) as { is_public: number } | undefined;

  if (!model) return false;
  if (model.is_public === 1) return true;

  return getEffectiveAllowedAliases(user).includes(alias);
}

export function hasEnabledModelAlias(alias: string) {
  const row = enabledModelAliasStmt.get(alias) as { 1: number } | undefined;

  return Boolean(row);
}

export function resolveAccessibleModelAlias(
  user: Pick<DbUser, "role" | "group_id" | "allowed_model_aliases">,
  requestedAlias: string,
): { ok: true; alias: string } | { ok: false; reason: "not_found" | "forbidden" } {
  const requestedAliasExists = hasEnabledModelAlias(requestedAlias);
  if (requestedAliasExists && canUserAccessModelAlias(user, requestedAlias)) {
    return { ok: true, alias: requestedAlias };
  }

  const wildcardAliasExists = hasEnabledModelAlias("*");
  if (wildcardAliasExists && canUserAccessModelAlias(user, "*")) {
    return { ok: true, alias: "*" };
  }

  return requestedAliasExists ? { ok: false, reason: "forbidden" } : { ok: false, reason: "not_found" };
}

export type AccessibleModelChannel = {
  channel_id: number;
  channel_name: string;
  token_multiplier: number;
  request_multiplier: number;
  effective_weight: number;
};

export type AccessibleModel = {
  alias: string;
  created_at: string | null;
  token_multiplier: number;
  request_multiplier: number;
  token_multiplier_min: number;
  token_multiplier_max: number;
  request_multiplier_min: number;
  request_multiplier_max: number;
  max_effective_weight: number;
  channels: AccessibleModelChannel[];
};

export function listAccessibleModelAliases(user: Pick<DbUser, "role" | "group_id" | "allowed_model_aliases">) {
  return listAccessibleModels(user).map((row) => row.alias);
}

export function listAccessibleModels(user: Pick<DbUser, "role" | "group_id" | "allowed_model_aliases">): AccessibleModel[] {
  const rows = accessibleModelRowsStmt.all() as Array<{ alias: string; is_public: number; created_at: string | null; token_multiplier: number; request_multiplier: number; model_weight: number; channel_id: number; channel_name: string; channel_weight: number }>;
  const allowedChannelIds = getUserAllowedChannelIds(user);
  const allowedChannelSet = allowedChannelIds ? new Set(allowedChannelIds) : null;

  type Accumulator = { alias: string; created_at: string | null; channels: AccessibleModelChannel[] };
  const visible = new Map<string, Accumulator>();

  const processRow = (row: typeof rows[number]) => {
    const tm = row.token_multiplier ?? 1;
    const rm = row.request_multiplier ?? 1;
    const ew = Math.max(1, row.model_weight ?? 1) * Math.max(1, row.channel_weight ?? 1);
    const current = visible.get(row.alias);
    if (!current) {
      visible.set(row.alias, { alias: row.alias, created_at: row.created_at, channels: [{ channel_id: row.channel_id, channel_name: row.channel_name, token_multiplier: tm, request_multiplier: rm, effective_weight: ew }] });
    } else {
      if ((row.created_at ?? "") > (current.created_at ?? "")) current.created_at = row.created_at;
      current.channels.push({ channel_id: row.channel_id, channel_name: row.channel_name, token_multiplier: tm, request_multiplier: rm, effective_weight: ew });
    }
  };

  if (user.role === "admin") {
    for (const row of rows) processRow(row);
  } else {
    const allowed = new Set(getEffectiveAllowedAliases(user));
    for (const row of rows) {
      if (allowedChannelSet && !allowedChannelSet.has(row.channel_id)) continue;
      if (row.is_public !== 1 && !allowed.has(row.alias)) continue;
      processRow(row);
    }
  }

  return [...visible.values()]
    .map((item) => {
      const tms = item.channels.map((c) => c.token_multiplier);
      const rms = item.channels.map((c) => c.request_multiplier);
      const ews = item.channels.map((c) => c.effective_weight);
      return {
        alias: item.alias,
        created_at: item.created_at,
        token_multiplier: Math.min(...tms),
        request_multiplier: Math.min(...rms),
        token_multiplier_min: Math.min(...tms),
        token_multiplier_max: Math.max(...tms),
        request_multiplier_min: Math.min(...rms),
        request_multiplier_max: Math.max(...rms),
        max_effective_weight: Math.max(...ews),
        channels: item.channels.sort((a, b) => b.effective_weight - a.effective_weight),
      };
    })
    .sort((a, b) => b.max_effective_weight - a.max_effective_weight || a.alias.localeCompare(b.alias));
}

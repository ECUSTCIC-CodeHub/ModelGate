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
   LIMIT 1`,
);

const accessibleModelRowsStmt = gatewayDb.prepare(
  `SELECT m.alias, m.is_public, m.created_at, c.id AS channel_id
   FROM models m
   JOIN channels c ON c.id = m.channel_id
   WHERE m.enabled = 1
     AND c.enabled = 1
     AND m.deleted_at IS NULL
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

export function listAccessibleModelAliases(user: Pick<DbUser, "role" | "group_id" | "allowed_model_aliases">) {
  return listAccessibleModels(user).map((row) => row.alias);
}

export function listAccessibleModels(user: Pick<DbUser, "role" | "group_id" | "allowed_model_aliases">) {
  const rows = accessibleModelRowsStmt.all() as Array<{ alias: string; is_public: number; created_at: string | null; channel_id: number }>;
  const allowedChannelIds = getUserAllowedChannelIds(user);
  const allowedChannelSet = allowedChannelIds ? new Set(allowedChannelIds) : null;
  const visible = new Map<string, { alias: string; created_at: string | null }>();

  if (user.role === "admin") {
    for (const row of rows) {
      const current = visible.get(row.alias);
      if (!current || (row.created_at ?? "") > (current.created_at ?? "")) {
        visible.set(row.alias, { alias: row.alias, created_at: row.created_at });
      }
    }
    return [...visible.values()];
  }

  const allowed = new Set(getEffectiveAllowedAliases(user));
  for (const row of rows) {
    if (allowedChannelSet && !allowedChannelSet.has(row.channel_id)) continue;
    if (row.is_public !== 1 && !allowed.has(row.alias)) continue;
    const current = visible.get(row.alias);
    if (!current || (row.created_at ?? "") > (current.created_at ?? "")) {
      visible.set(row.alias, { alias: row.alias, created_at: row.created_at });
    }
  }
  return [...visible.values()];
}

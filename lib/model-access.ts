import { gatewayDb, type DbUser } from "@/lib/db";
import { getUserGroup } from "@/lib/effective-limits";

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

export function canUserAccessModelAlias(user: Pick<DbUser, "role" | "group_id" | "allowed_model_aliases">, alias: string) {
  if (user.role === "admin") return true;

  const model = gatewayDb
    .prepare(
      `SELECT is_public
       FROM models
       WHERE alias = ? AND enabled = 1 AND deleted_at IS NULL
       LIMIT 1`,
    )
    .get(alias) as { is_public: number } | undefined;

  if (!model) return false;
  if (model.is_public === 1) return true;

  return getEffectiveAllowedAliases(user).includes(alias);
}

export function hasEnabledModelAlias(alias: string) {
  const row = gatewayDb
    .prepare(
      `SELECT 1
       FROM models m
       JOIN channels c ON c.id = m.channel_id
       WHERE m.alias = ?
         AND m.enabled = 1
         AND c.enabled = 1
         AND m.deleted_at IS NULL
       LIMIT 1`,
    )
    .get(alias) as { 1: number } | undefined;

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
  const rows = gatewayDb
    .prepare(
      `SELECT DISTINCT m.alias, m.is_public
       FROM models m
       JOIN channels c ON c.id = m.channel_id
       WHERE m.enabled = 1
         AND c.enabled = 1
         AND m.deleted_at IS NULL
         AND m.alias != '*'
       ORDER BY m.alias ASC`,
    )
    .all() as Array<{ alias: string; is_public: number }>;

  if (user.role === "admin") {
    return rows.map((row) => row.alias);
  }

  const allowed = new Set(getEffectiveAllowedAliases(user));
  return rows.filter((row) => row.is_public === 1 || allowed.has(row.alias)).map((row) => row.alias);
}

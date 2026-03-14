import { gatewayDb, type DbUser } from "@/lib/db";

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

export function canUserAccessModelAlias(user: Pick<DbUser, "role" | "allowed_model_aliases">, alias: string) {
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

  return parseAllowedModelAliases(user.allowed_model_aliases).includes(alias);
}

export function listAccessibleModelAliases(user: Pick<DbUser, "role" | "allowed_model_aliases">) {
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

  const allowed = new Set(parseAllowedModelAliases(user.allowed_model_aliases));
  return rows.filter((row) => row.is_public === 1 || allowed.has(row.alias)).map((row) => row.alias);
}

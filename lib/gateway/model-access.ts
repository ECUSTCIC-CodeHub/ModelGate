import { gatewayDb, type DbUser } from "@/lib/core/db";
import { getUserAllowedChannelIds } from "@/lib/gateway/channel-access";
import { getUserGroup } from "@/lib/gateway/effective-limits";
import { parseSupportedProtocols, type GatewayProtocol } from "@/lib/gateway/protocols";

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

export async function listExistingModelAliases(aliases: string[]): Promise<string[]> {
  if (aliases.length === 0) return [];
  const placeholders = aliases.map(() => "?").join(",");
  const rows = await gatewayDb.query<{ alias: string }>(
    `SELECT DISTINCT alias FROM models WHERE alias IN (${placeholders}) AND enabled = 1 AND deleted_at IS NULL`,
    aliases,
  );
  const existing = new Set(rows.map((r) => r.alias));
  return aliases.filter((a) => existing.has(a));
}

export async function getEffectiveAllowedAliases(user: Pick<DbUser, "group_id" | "allowed_model_aliases">): Promise<string[]> {
  const userAliases = parseAllowedModelAliases(user.allowed_model_aliases);
  const group = await getUserGroup(user.group_id ?? null);
  if (!group) return userAliases;
  const groupAliases = parseAllowedModelAliases(group.allowed_model_aliases);
  return [...new Set([...userAliases, ...groupAliases])];
}

const MODEL_PUBLIC_BY_ALIAS_SQL = `SELECT is_public
   FROM models
   WHERE alias = ? AND enabled = 1 AND deleted_at IS NULL
   LIMIT 1`;

const ENABLED_MODEL_ALIAS_SQL = `SELECT 1
   FROM models m
   JOIN channels c ON c.id = m.channel_id
   WHERE m.alias = ?
     AND m.enabled = 1
     AND c.enabled = 1
     AND m.deleted_at IS NULL
     AND c.deleted_at IS NULL
   LIMIT 1`;

const ACCESSIBLE_MODEL_ROWS_SQL = `SELECT m.alias, m.real_model, m.is_public, m.created_at, m.token_multiplier, m.request_multiplier, m.supports_vision, m.supported_protocols,
      m.weight AS model_weight,
      c.id AS channel_id, c.name AS channel_name, c.weight AS channel_weight
   FROM models m
   JOIN channels c ON c.id = m.channel_id
   WHERE m.enabled = 1
     AND c.enabled = 1
     AND m.deleted_at IS NULL
     AND c.deleted_at IS NULL
     AND m.alias != '*'
   ORDER BY m.alias ASC, m.id ASC`;

export async function canUserAccessModelAlias(user: Pick<DbUser, "role" | "group_id" | "allowed_model_aliases">, alias: string) {
  if (user.role === "admin") return true;

  const model = await gatewayDb.queryOne<{ is_public: number }>(MODEL_PUBLIC_BY_ALIAS_SQL, [alias]);

  if (!model) return false;
  if (model.is_public === 1) return true;

  const effective = await getEffectiveAllowedAliases(user);
  return effective.includes(alias);
}

export async function hasEnabledModelAlias(alias: string) {
  const row = await gatewayDb.queryOne<{ 1: number }>(ENABLED_MODEL_ALIAS_SQL, [alias]);
  return Boolean(row);
}

export async function resolveAccessibleModelAlias(
  user: Pick<DbUser, "role" | "group_id" | "allowed_model_aliases">,
  requestedAlias: string,
): Promise<{ ok: true; alias: string } | { ok: false; reason: "not_found" | "forbidden" }> {
  const requestedAliasExists = await hasEnabledModelAlias(requestedAlias);
  if (requestedAliasExists && await canUserAccessModelAlias(user, requestedAlias)) {
    return { ok: true, alias: requestedAlias };
  }

  const wildcardAliasExists = await hasEnabledModelAlias("*");
  if (wildcardAliasExists && await canUserAccessModelAlias(user, "*")) {
    return { ok: true, alias: "*" };
  }

  return requestedAliasExists ? { ok: false, reason: "forbidden" } : { ok: false, reason: "not_found" };
}

export type AccessibleModelChannel = {
  channel_id: number;
  channel_name: string;
  real_model: string;
  token_multiplier: number;
  request_multiplier: number;
  effective_weight: number;
};

export type AccessibleModel = {
  alias: string;
  created_at: string | null;
  supports_vision: number;
  supported_protocols: GatewayProtocol[];
  token_multiplier: number;
  request_multiplier: number;
  token_multiplier_min: number;
  token_multiplier_max: number;
  request_multiplier_min: number;
  request_multiplier_max: number;
  max_effective_weight: number;
  channels: AccessibleModelChannel[];
};

export async function listAccessibleModelAliases(user: Pick<DbUser, "role" | "group_id" | "allowed_model_aliases">) {
  const models = await listAccessibleModels(user);
  return models.map((row) => row.alias);
}

export async function listAccessibleModels(user: Pick<DbUser, "role" | "group_id" | "allowed_model_aliases">): Promise<AccessibleModel[]> {
  const rows = await gatewayDb.query<{ alias: string; real_model: string; is_public: number; created_at: string | null; token_multiplier: number; request_multiplier: number; supports_vision: number; supported_protocols: string; model_weight: number; channel_id: number; channel_name: string; channel_weight: number }>(ACCESSIBLE_MODEL_ROWS_SQL);
  const allowedChannelIds = await getUserAllowedChannelIds(user);
  const allowedChannelSet = allowedChannelIds ? new Set(allowedChannelIds) : null;

  type Accumulator = { alias: string; created_at: string | null; supports_vision: number; supported_protocols: Set<GatewayProtocol>; channels: AccessibleModelChannel[] };
  const visible = new Map<string, Accumulator>();

  const processRow = (row: typeof rows[number]) => {
    const tm = row.token_multiplier ?? 1;
    const rm = row.request_multiplier ?? 1;
    const ew = Math.max(1, row.model_weight ?? 1) * Math.max(1, row.channel_weight ?? 1);
    const sv = row.supports_vision ?? 0;
    const current = visible.get(row.alias);
    if (!current) {
      visible.set(row.alias, { alias: row.alias, created_at: row.created_at, supports_vision: sv, supported_protocols: new Set(parseSupportedProtocols(row.supported_protocols)), channels: [{ channel_id: row.channel_id, channel_name: row.channel_name, real_model: row.real_model, token_multiplier: tm, request_multiplier: rm, effective_weight: ew }] });
    } else {
      if ((row.created_at ?? "") > (current.created_at ?? "")) current.created_at = row.created_at;
      if (sv > current.supports_vision) current.supports_vision = sv;
      for (const p of parseSupportedProtocols(row.supported_protocols)) current.supported_protocols.add(p);
      current.channels.push({ channel_id: row.channel_id, channel_name: row.channel_name, real_model: row.real_model, token_multiplier: tm, request_multiplier: rm, effective_weight: ew });
    }
  };

  if (user.role === "admin") {
    for (const row of rows) processRow(row);
  } else {
    const allowed = new Set(await getEffectiveAllowedAliases(user));
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
        supports_vision: item.supports_vision,
        supported_protocols: [...item.supported_protocols],
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

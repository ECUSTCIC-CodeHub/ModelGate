import { gatewayDb, type DbChannel, type DbModel } from "@/lib/core/db";
import { scoreChannel } from "@/lib/gateway/channel-runtime";
import type { GatewayProtocol } from "@/lib/gateway/protocols";

export type RoutedModel = {
  model: DbModel;
  channel: DbChannel;
};

type CandidateRow = {
  model_id: number;
  alias: string;
  real_model: string;
  channel_id: number;
  upstream_protocol: GatewayProtocol;
  is_public: number;
  model_enabled: number;
  model_weight: number;
  token_multiplier: number;
  request_multiplier: number;
  model_max_concurrency: number;
  model_created_at: string;
  model_deleted_at: string | null;
  channel_id_2: number;
  name: string;
  base_url: string;
  api_key: string;
  supported_protocols: string;
  channel_enabled: number;
  channel_weight: number;
  channel_max_concurrency: number;
  timeout: number;
  channel_created_at: string;
  channel_deleted_at: string | null;
};

const listEnabledAliasesStmt = gatewayDb.prepare(
  `SELECT DISTINCT m.alias
   FROM models m
   JOIN channels c ON c.id = m.channel_id
   WHERE m.enabled = 1 AND c.enabled = 1 AND m.deleted_at IS NULL AND m.alias != '*'
   ORDER BY m.alias ASC`,
);

const listModelRoutesStmt = gatewayDb.prepare(
  `SELECT
      m.id as model_id,
      m.alias,
      m.real_model,
      m.channel_id,
      m.upstream_protocol,
      m.is_public,
      m.enabled as model_enabled,
      m.weight as model_weight,
      m.token_multiplier,
      m.request_multiplier,
      m.max_concurrency as model_max_concurrency,
      m.created_at as model_created_at,
      m.deleted_at as model_deleted_at,
      c.id as channel_id_2,
      c.name,
      c.base_url,
      c.api_key,
      c.supported_protocols,
      c.enabled as channel_enabled,
      c.weight as channel_weight,
      c.max_concurrency as channel_max_concurrency,
      c.timeout,
      c.created_at as channel_created_at,
      c.deleted_at as channel_deleted_at
   FROM models m
   JOIN channels c ON c.id = m.channel_id
   WHERE m.alias = ? AND m.enabled = 1 AND c.enabled = 1 AND m.deleted_at IS NULL AND c.deleted_at IS NULL`,
);

export function listEnabledAliases() {
  return listEnabledAliasesStmt.all() as { alias: string }[];
}

function effectiveMaxConcurrency(channelMax: number, modelMax: number): number {
  if (modelMax > 0) return Math.min(channelMax, modelMax);
  return channelMax;
}

function mapRowToRoute(row: CandidateRow): RoutedModel {
  return {
    model: {
      id: row.model_id,
      alias: row.alias,
      real_model: row.real_model,
      channel_id: row.channel_id,
      upstream_protocol: row.upstream_protocol,
      is_public: row.is_public,
      enabled: row.model_enabled,
      weight: row.model_weight,
      token_multiplier: row.token_multiplier ?? 1,
      request_multiplier: row.request_multiplier ?? 1,
      max_concurrency: row.model_max_concurrency,
      created_at: row.model_created_at,
      deleted_at: row.model_deleted_at,
    },
    channel: {
      id: row.channel_id_2,
      name: row.name,
      base_url: row.base_url,
      api_key: row.api_key,
      supported_protocols: row.supported_protocols,
      enabled: row.channel_enabled,
      weight: row.channel_weight,
      max_concurrency: effectiveMaxConcurrency(row.channel_max_concurrency, row.model_max_concurrency),
      timeout: row.timeout,
      created_at: row.channel_created_at,
      deleted_at: row.channel_deleted_at,
    },
  };
}

function isProtocolCompatible(inboundProtocol: GatewayProtocol, upstreamProtocol: GatewayProtocol) {
  if (inboundProtocol === "embeddings") return upstreamProtocol === "embeddings";
  return upstreamProtocol !== "embeddings";
}

export function listModelRoutes(alias: string, options?: { excludeChannelIds?: number[]; protocol?: GatewayProtocol; allowedChannelIds?: number[] | null }): RoutedModel[] {
  const exclude = new Set(options?.excludeChannelIds ?? []);
  const protocol = options?.protocol;
  const allowSet = options?.allowedChannelIds && options.allowedChannelIds.length > 0
    ? new Set(options.allowedChannelIds)
    : null;
  const findRows = (targetAlias: string) => listModelRoutesStmt.all(targetAlias) as CandidateRow[];

  const filterRows = (rows: CandidateRow[]) => rows.filter((row) =>
    !exclude.has(row.channel_id_2)
    && (!allowSet || allowSet.has(row.channel_id_2))
    && (!protocol || isProtocolCompatible(protocol, row.upstream_protocol)),
  );

  const exactRows = filterRows(findRows(alias));
  const candidateRows = exactRows.length > 0
    ? exactRows
    : filterRows(findRows("*"));

  return candidateRows
    .map((row) => ({
      route: mapRowToRoute(row),
      score: scoreChannel(
        row.channel_id_2,
        Math.max(1, row.model_weight) * Math.max(1, row.channel_weight),
        effectiveMaxConcurrency(row.channel_max_concurrency, row.model_max_concurrency),
      ),
      jitter: Math.random() * 0.001,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => (b.score + b.jitter) - (a.score + a.jitter))
    .map((item) => item.route);
}

export function selectModelRoute(alias: string, options?: { excludeChannelIds?: number[]; protocol?: GatewayProtocol; allowedChannelIds?: number[] | null }): RoutedModel | null {
  return listModelRoutes(alias, options)[0] ?? null;
}

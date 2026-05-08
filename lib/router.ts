import { gatewayDb, type DbChannel, type DbModel } from "@/lib/db";
import { scoreChannel } from "@/lib/channel-runtime";
import type { GatewayProtocol } from "@/lib/protocols";

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
  model_created_at: string;
  model_deleted_at: string | null;
  channel_id_2: number;
  name: string;
  base_url: string;
  api_key: string;
  supported_protocols: string;
  channel_enabled: number;
  channel_weight: number;
  max_concurrency: number;
  timeout: number;
  channel_created_at: string;
  channel_deleted_at: string | null;
};

export function listEnabledAliases() {
  return gatewayDb
    .prepare(
      `SELECT DISTINCT m.alias
       FROM models m
       JOIN channels c ON c.id = m.channel_id
       WHERE m.enabled = 1 AND c.enabled = 1 AND m.deleted_at IS NULL AND m.alias != '*'
       ORDER BY m.alias ASC`,
    )
    .all() as { alias: string }[];
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
      max_concurrency: row.max_concurrency,
      timeout: row.timeout,
      created_at: row.channel_created_at,
      deleted_at: row.channel_deleted_at,
    },
  };
}

export function listModelRoutes(alias: string, options?: { excludeChannelIds?: number[] }): RoutedModel[] {
  const exclude = new Set(options?.excludeChannelIds ?? []);
  const query = gatewayDb.prepare(
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
        m.created_at as model_created_at,
        m.deleted_at as model_deleted_at,
        c.id as channel_id_2,
        c.name,
        c.base_url,
        c.api_key,
        c.supported_protocols,
        c.enabled as channel_enabled,
        c.weight as channel_weight,
        c.max_concurrency,
        c.timeout,
        c.created_at as channel_created_at,
        c.deleted_at as channel_deleted_at
     FROM models m
     JOIN channels c ON c.id = m.channel_id
     WHERE m.alias = ? AND m.enabled = 1 AND c.enabled = 1 AND m.deleted_at IS NULL AND c.deleted_at IS NULL`,
  );

  const findRows = (targetAlias: string) => query.all(targetAlias) as CandidateRow[];

  const exactRows = findRows(alias).filter((row) => !exclude.has(row.channel_id_2));
  const candidateRows = exactRows.length > 0
    ? exactRows
    : findRows("*").filter((row) => !exclude.has(row.channel_id_2));

  return candidateRows
    .map((row) => ({
      route: mapRowToRoute(row),
      score: scoreChannel(
        row.channel_id_2,
        Math.max(1, row.model_weight) * Math.max(1, row.channel_weight),
        row.max_concurrency,
      ),
      jitter: Math.random() * 0.001,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => (b.score + b.jitter) - (a.score + a.jitter))
    .map((item) => item.route);
}

export function selectModelRoute(alias: string, options?: { excludeChannelIds?: number[] }): RoutedModel | null {
  return listModelRoutes(alias, options)[0] ?? null;
}

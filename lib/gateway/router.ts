import { gatewayDb, type DbChannel, type DbModel } from "@/lib/core/db";
import type { ModelQuotaMode } from "@/lib/core/db/types";
import { makeModelRuntimeKey, scoreChannel } from "@/lib/gateway/channel-runtime";
import { parseSupportedProtocols, type GatewayProtocol } from "@/lib/gateway/protocols";

export type RoutedModel = {
  model: DbModel;
  channel: DbChannel;
  /** The protocol actually used to talk upstream. When the channel natively
   *  supports the inbound protocol, this equals the inbound protocol so the
   *  request can be forwarded without any protocol conversion. Otherwise it
   *  falls back to the model's configured upstream_protocol. */
  effective_upstream_protocol: GatewayProtocol;
};

type CandidateRow = {
  model_id: number;
  alias: string;
  real_model: string;
  channel_id: number;
  upstream_protocol: GatewayProtocol;
  model_supported_protocols: string | null;
  is_public: number;
  model_enabled: number;
  model_weight: number;
  token_multiplier: number;
  request_multiplier: number;
  model_max_concurrency: number;
  model_quota_mode: ModelQuotaMode;
  model_quota_tokens: number | null;
  model_quota_requests: number | null;
  model_quota_period: number | null;
  model_period_quota_tokens: number | null;
  model_period_quota_requests: number | null;
  model_period_used_tokens: number;
  model_period_used_requests: number;
  model_period_reset_at: string | null;
  model_created_at: string;
  model_deleted_at: string | null;
  channel_id_2: number;
  name: string;
  base_url: string;
  api_key: string;
  supported_protocols: string;
  user_agent: string;
  channel_enabled: number;
  channel_weight: number;
  channel_max_concurrency: number;
  timeout: number;
  channel_quota_tokens: number | null;
  channel_quota_requests: number | null;
  channel_quota_period: number | null;
  channel_period_quota_tokens: number | null;
  channel_period_quota_requests: number | null;
  channel_period_used_tokens: number;
  channel_period_used_requests: number;
  channel_period_reset_at: string | null;
  channel_created_at: string;
  channel_deleted_at: string | null;
  channel_force_include_usage: number;
};

const listEnabledAliasesStmt = gatewayDb.prepare(
  `SELECT DISTINCT m.alias
   FROM models m
   JOIN channels c ON c.id = m.channel_id
   WHERE m.enabled = 1 AND c.enabled = 1 AND m.deleted_at IS NULL AND c.deleted_at IS NULL AND m.alias != '*'
   ORDER BY m.alias ASC`,
);

const listModelRoutesStmt = gatewayDb.prepare(
  `SELECT
      m.id as model_id,
      m.alias,
      m.real_model,
      m.channel_id,
      m.upstream_protocol,
      m.supported_protocols as model_supported_protocols,
      m.is_public,
      m.enabled as model_enabled,
      m.weight as model_weight,
      m.token_multiplier,
      m.request_multiplier,
      m.max_concurrency as model_max_concurrency,
      m.quota_mode as model_quota_mode,
      m.quota_tokens as model_quota_tokens,
      m.quota_requests as model_quota_requests,
      m.quota_period as model_quota_period,
      m.period_quota_tokens as model_period_quota_tokens,
      m.period_quota_requests as model_period_quota_requests,
      m.period_used_tokens as model_period_used_tokens,
      m.period_used_requests as model_period_used_requests,
      m.period_reset_at as model_period_reset_at,
      m.created_at as model_created_at,
      m.deleted_at as model_deleted_at,
      c.id as channel_id_2,
      c.name,
      c.base_url,
      c.api_key,
      c.supported_protocols,
      c.user_agent,
      c.enabled as channel_enabled,
      c.weight as channel_weight,
      c.max_concurrency as channel_max_concurrency,
      c.timeout,
      c.quota_tokens as channel_quota_tokens,
      c.quota_requests as channel_quota_requests,
      c.quota_period as channel_quota_period,
      c.period_quota_tokens as channel_period_quota_tokens,
      c.period_quota_requests as channel_period_quota_requests,
      c.period_used_tokens as channel_period_used_tokens,
      c.period_used_requests as channel_period_used_requests,
      c.period_reset_at as channel_period_reset_at,
      c.created_at as channel_created_at,
      c.deleted_at as channel_deleted_at,
      c.force_include_usage as channel_force_include_usage
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

function mapRowToRoute(row: CandidateRow, inboundProtocol?: GatewayProtocol): RoutedModel {
  const channelProtocols = parseSupportedProtocols(row.supported_protocols);
  const modelProtocols = row.model_supported_protocols
    ? parseSupportedProtocols(row.model_supported_protocols)
    : channelProtocols;
  const effectiveUpstreamProtocol = inboundProtocol && modelProtocols.includes(inboundProtocol) && channelProtocols.includes(inboundProtocol)
    ? inboundProtocol
    : row.upstream_protocol;
  return {
    model: {
      id: row.model_id,
      alias: row.alias,
      real_model: row.real_model,
      channel_id: row.channel_id,
      upstream_protocol: row.upstream_protocol,
      supported_protocols: row.model_supported_protocols ?? "",
      is_public: row.is_public,
      enabled: row.model_enabled,
      weight: row.model_weight,
      token_multiplier: row.token_multiplier ?? 1,
      request_multiplier: row.request_multiplier ?? 1,
      max_concurrency: row.model_max_concurrency,
      quota_mode: row.model_quota_mode ?? "follow_group",
      quota_tokens: row.model_quota_tokens,
      quota_requests: row.model_quota_requests,
      quota_period: row.model_quota_period,
      period_quota_tokens: row.model_period_quota_tokens,
      period_quota_requests: row.model_period_quota_requests,
      period_used_tokens: row.model_period_used_tokens,
      period_used_requests: row.model_period_used_requests,
      period_reset_at: row.model_period_reset_at,
      created_at: row.model_created_at,
      deleted_at: row.model_deleted_at,
    },
    channel: {
      id: row.channel_id_2,
      name: row.name,
      base_url: row.base_url,
      api_key: row.api_key,
      supported_protocols: row.supported_protocols,
      user_agent: row.user_agent ?? "",
      enabled: row.channel_enabled,
      weight: row.channel_weight,
      max_concurrency: effectiveMaxConcurrency(row.channel_max_concurrency, row.model_max_concurrency),
      timeout: row.timeout,
      quota_tokens: row.channel_quota_tokens,
      quota_requests: row.channel_quota_requests,
      quota_period: row.channel_quota_period,
      period_quota_tokens: row.channel_period_quota_tokens,
      period_quota_requests: row.channel_period_quota_requests,
      period_used_tokens: row.channel_period_used_tokens,
      period_used_requests: row.channel_period_used_requests,
      period_reset_at: row.channel_period_reset_at,
      created_at: row.channel_created_at,
      deleted_at: row.channel_deleted_at,
      force_include_usage: row.channel_force_include_usage ?? 1,
    },
    effective_upstream_protocol: effectiveUpstreamProtocol,
  };
}

const PASSTHROUGH_PROTOCOLS: GatewayProtocol[] = ["embeddings", "images"];

function isProtocolCompatible(inboundProtocol: GatewayProtocol, upstreamProtocol: GatewayProtocol, modelProtocols: GatewayProtocol[], channelProtocols: GatewayProtocol[]) {
  if (!channelProtocols.includes(upstreamProtocol)) return false;
  if (!modelProtocols.includes(upstreamProtocol)) return false;
  if (PASSTHROUGH_PROTOCOLS.includes(inboundProtocol)) return inboundProtocol === upstreamProtocol;
  return !PASSTHROUGH_PROTOCOLS.includes(upstreamProtocol);
}

export function listModelRoutes(alias: string, options?: { excludeChannelIds?: number[]; protocol?: GatewayProtocol; allowedChannelIds?: number[] | null }): RoutedModel[] {
  const exclude = new Set(options?.excludeChannelIds ?? []);
  const protocol = options?.protocol;
  const allowSet = options?.allowedChannelIds && options.allowedChannelIds.length > 0
    ? new Set(options.allowedChannelIds)
    : null;
  const findRows = (targetAlias: string) => listModelRoutesStmt.all(targetAlias) as CandidateRow[];

  const filterRows = (rows: CandidateRow[]) => rows.filter((row) => {
    if (exclude.has(row.channel_id_2)) return false;
    if (allowSet && !allowSet.has(row.channel_id_2)) return false;
    if (protocol) {
      const channelProtocols = parseSupportedProtocols(row.supported_protocols);
      const modelProtocols = row.model_supported_protocols
        ? parseSupportedProtocols(row.model_supported_protocols)
        : channelProtocols;
      if (!isProtocolCompatible(protocol, row.upstream_protocol, modelProtocols, channelProtocols)) return false;
    }
    return true;
  });

  const exactRows = filterRows(findRows(alias));
  const candidateRows = exactRows.length > 0
    ? exactRows
    : filterRows(findRows("*"));

  return candidateRows
    .map((row) => {
      const route = mapRowToRoute(row, protocol);
      const baseScore = scoreChannel(
        makeModelRuntimeKey(row.channel_id_2, row.real_model),
        Math.max(1, row.model_weight) * Math.max(1, row.channel_weight),
        effectiveMaxConcurrency(row.channel_max_concurrency, row.model_max_concurrency),
      );
      const passthroughBonus = protocol && route.effective_upstream_protocol === protocol ? 1.05 : 1;
      return {
        route,
        score: baseScore * passthroughBonus,
        jitter: Math.random() * 0.001,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => (b.score + b.jitter) - (a.score + a.jitter))
    .map((item) => item.route);
}

export function selectModelRoute(alias: string, options?: { excludeChannelIds?: number[]; protocol?: GatewayProtocol; allowedChannelIds?: number[] | null }): RoutedModel | null {
  return listModelRoutes(alias, options)[0] ?? null;
}

import { gatewayDb, type DbUser } from "@/lib/core/db";
import { getUserAllowedChannelIds } from "@/lib/gateway/channel-access";
import { getUserGroup } from "@/lib/gateway/effective-limits";
import { parseSupportedProtocols, type GatewayProtocol } from "@/lib/gateway/protocols";
import { parseMultiplierSchedules, resolveLayeredMultiplier } from "@/lib/gateway/multiplier-schedule";
import { getUserScope, listRedeemScopes, scopeCoversPair, scopesCoverPair, scopesHaveAlias } from "@/lib/services/redeem-authorization";

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
   WHERE alias = ? AND enabled = 1 AND deleted_at IS NULL`;

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
      m.multiplier_schedules AS model_multiplier_schedules,
      m.weight AS model_weight,
      c.id AS channel_id, c.name AS channel_name, c.weight AS channel_weight, c.multiplier_schedules AS channel_multiplier_schedules
   FROM models m
   JOIN channels c ON c.id = m.channel_id
   WHERE m.enabled = 1
     AND c.enabled = 1
     AND m.deleted_at IS NULL
     AND c.deleted_at IS NULL
     AND m.alias != '*'
   ORDER BY m.alias ASC, m.id ASC`;

type AliasGrantSource = "public" | "whitelist" | "redeem";

// 别名可见性的唯一来源判定，按优先级返回来源：
//   public    该别名存在公开实例
//   whitelist 在用户/组模型白名单内
//   redeem    仅由某张有效定向额度（兑换码）的别名维度覆盖
// 来源要区分开：只有 redeem 来源属于「按渠道配对的授权尚未验证」，选路为空时
// 应判定为无权限，而不是当别名不存在（详见 gateway-handler 的 403/404 分支）。
async function resolveAliasGrantSource(
  user: Pick<DbUser, "id" | "role" | "group_id" | "allowed_model_aliases">,
  alias: string,
): Promise<AliasGrantSource | null> {
  if (user.role === "admin") return "public";

  const models = await gatewayDb.query<{ is_public: number }>(MODEL_PUBLIC_BY_ALIAS_SQL, [alias]);
  if (models.length === 0) return null;
  if (models.some((m) => m.is_public === 1)) return "public";

  const effective = await getEffectiveAllowedAliases(user);
  if (effective.includes(alias)) return "whitelist";

  // 定额度限定的别名也是授权来源（兑换即授权）。此处只有别名维度（渠道未知），
  // 故用「任意渠道」的宽松口径放行，配对收紧交给选路阶段的 filterGrantedRows。
  return scopesHaveAlias(await listRedeemScopes(user.id), alias) ? "redeem" : null;
}

export async function hasEnabledModelAlias(alias: string) {
  const row = await gatewayDb.queryOne<{ 1: number }>(ENABLED_MODEL_ALIAS_SQL, [alias]);
  return Boolean(row);
}

export async function resolveAccessibleModelAlias(
  user: Pick<DbUser, "id" | "role" | "group_id" | "allowed_model_aliases">,
  requestedAlias: string,
): Promise<{ ok: true; alias: string; viaRedeemScope: boolean } | { ok: false; reason: "not_found" | "forbidden" }> {
  const requestedAliasExists = await hasEnabledModelAlias(requestedAlias);
  if (requestedAliasExists) {
    const source = await resolveAliasGrantSource(user, requestedAlias);
    if (source !== null) return { ok: true, alias: requestedAlias, viaRedeemScope: source === "redeem" };
  }

  const wildcardAliasExists = await hasEnabledModelAlias("*");
  if (wildcardAliasExists) {
    const source = await resolveAliasGrantSource(user, "*");
    if (source !== null) return { ok: true, alias: "*", viaRedeemScope: source === "redeem" };
  }

  return requestedAliasExists ? { ok: false, reason: "forbidden" } : { ok: false, reason: "not_found" };
}

export type AccessibleModelChannel = {
  channel_id: number;
  channel_name: string;
  real_model: string;
  token_multiplier: number;
  request_multiplier: number;
  // 当前时刻实际生效的倍率：模型分时档优先，渠道分时档只补模型留空的维度
  effective_token_multiplier: number;
  effective_request_multiplier: number;
  // 当前是否命中分时档位（模型档或渠道档任一命中）
  multiplier_schedule_applied: boolean;
  // 生效倍率来自哪一层：true 表示该维度由模型自己的分时档决定，false 表示由渠道分时档补足。
  // 同一渠道下不同别名命中不同层，明细里要分开标，否则用户看不出为什么同渠道价格不一样。
  token_multiplier_from_model_schedule: boolean;
  request_multiplier_from_model_schedule: boolean;
  weight: number;
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
  effective_token_multiplier_min: number;
  effective_token_multiplier_max: number;
  effective_request_multiplier_min: number;
  effective_request_multiplier_max: number;
  multiplier_schedule_applied: boolean;
  weight_min: number;
  weight_max: number;
  effective_weight_min: number;
  effective_weight_max: number;
  max_effective_weight: number;
  channels: AccessibleModelChannel[];
};

export async function listAccessibleModelAliases(user: Pick<DbUser, "id" | "role" | "group_id" | "allowed_model_aliases">) {
  const models = await listAccessibleModels(user);
  return models.map((row) => row.alias);
}

export async function listAccessibleModels(user: Pick<DbUser, "id" | "role" | "group_id" | "allowed_model_aliases">): Promise<AccessibleModel[]> {
  const rows = await gatewayDb.query<{ alias: string; real_model: string; is_public: number; created_at: string | null; token_multiplier: number; request_multiplier: number; supports_vision: number; supported_protocols: string; model_multiplier_schedules: string | null; model_weight: number; channel_id: number; channel_name: string; channel_weight: number; channel_multiplier_schedules: string | null }>(ACCESSIBLE_MODEL_ROWS_SQL);
  const allowedChannelIds = await getUserAllowedChannelIds(user);
  const allowedChannelSet = allowedChannelIds ? new Set(allowedChannelIds) : null;

  type Accumulator = { alias: string; created_at: string | null; supports_vision: number; supported_protocols: Set<GatewayProtocol>; channels: AccessibleModelChannel[] };
  const visible = new Map<string, Accumulator>();

  // 生效倍率按请求时刻算一次：模型档优先，渠道档只补模型留空的维度。
  // 列表面板展示的是「现在下单什么价」，因此以生效值为准，基础倍率仅作参考。
  const now = new Date();
  const processRow = (row: typeof rows[number]) => {
    const tm = row.token_multiplier ?? 1;
    const rm = row.request_multiplier ?? 1;
    const ew = Math.max(1, row.model_weight ?? 1) * Math.max(1, row.channel_weight ?? 1);
    const sv = row.supports_vision ?? 0;
    const effective = resolveLayeredMultiplier(
      tm,
      rm,
      [parseMultiplierSchedules(row.model_multiplier_schedules), parseMultiplierSchedules(row.channel_multiplier_schedules)],
      now,
    );
    const channel: AccessibleModelChannel = {
      channel_id: row.channel_id,
      channel_name: row.channel_name,
      real_model: row.real_model,
      token_multiplier: tm,
      request_multiplier: rm,
      effective_token_multiplier: effective.token_multiplier,
      effective_request_multiplier: effective.request_multiplier,
      multiplier_schedule_applied: effective.schedule_applied,
      token_multiplier_from_model_schedule: effective.token_source === 0,
      request_multiplier_from_model_schedule: effective.request_source === 0,
      weight: row.model_weight ?? 1,
      effective_weight: ew,
    };
    const current = visible.get(row.alias);
    if (!current) {
      visible.set(row.alias, { alias: row.alias, created_at: row.created_at, supports_vision: sv, supported_protocols: new Set(parseSupportedProtocols(row.supported_protocols)), channels: [channel] });
    } else {
      if ((row.created_at ?? "") > (current.created_at ?? "")) current.created_at = row.created_at;
      if (sv > current.supports_vision) current.supports_vision = sv;
      for (const p of parseSupportedProtocols(row.supported_protocols)) current.supported_protocols.add(p);
      current.channels.push(channel);
    }
  };

  if (user.role === "admin") {
    for (const row of rows) processRow(row);
  } else {
    const userScope = await getUserScope(user);
    const redeemScopes = await listRedeemScopes(user.id);
    for (const row of rows) {
      // 渠道白名单对所有模型生效，公开模型也不例外：选路阶段的 allowSet 一视同仁，
      // 展示侧若对公开模型放开，就会列出「看得见、请求必然 403」的组合。
      if (allowedChannelSet && !allowedChannelSet.has(row.channel_id)) continue;
      // 其余模型再按 (渠道, 别名) 配对校验，与网关实际选路保持一致。
      if (row.is_public !== 1) {
        const granted = (userScope !== null && scopeCoversPair(userScope, row.channel_id, row.alias))
          || scopesCoverPair(redeemScopes, row.channel_id, row.alias);
        if (!granted) continue;
      }
      processRow(row);
    }
  }

  return [...visible.values()]
    .map((item) => {
      const tms = item.channels.map((c) => c.token_multiplier);
      const rms = item.channels.map((c) => c.request_multiplier);
      const etms = item.channels.map((c) => c.effective_token_multiplier);
      const erms = item.channels.map((c) => c.effective_request_multiplier);
      const ws = item.channels.map((c) => c.weight);
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
        effective_token_multiplier_min: Math.min(...etms),
        effective_token_multiplier_max: Math.max(...etms),
        effective_request_multiplier_min: Math.min(...erms),
        effective_request_multiplier_max: Math.max(...erms),
        multiplier_schedule_applied: item.channels.some((c) => c.multiplier_schedule_applied),
        weight_min: Math.min(...ws),
        weight_max: Math.max(...ws),
        effective_weight_min: Math.min(...ews),
        effective_weight_max: Math.max(...ews),
        max_effective_weight: Math.max(...ews),
        channels: item.channels.sort((a, b) => b.effective_weight - a.effective_weight),
      };
    })
    .sort((a, b) => b.max_effective_weight - a.max_effective_weight || a.alias.localeCompare(b.alias));
}

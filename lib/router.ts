import { gatewayDb, type DbChannel, type DbModel } from "@/lib/db";

export type RoutedModel = {
  model: DbModel;
  channel: DbChannel;
};

export function listEnabledAliases() {
  return gatewayDb
    .prepare(
      `SELECT DISTINCT m.alias
       FROM models m
       JOIN channels c ON c.id = m.channel_id
       WHERE m.enabled = 1 AND c.enabled = 1
       ORDER BY m.alias ASC`,
    )
    .all() as { alias: string }[];
}

export function selectModelRoute(alias: string): RoutedModel | null {
  const rows = gatewayDb
    .prepare(
      `SELECT
          m.id as model_id,
          m.alias,
          m.real_model,
          m.channel_id,
          m.enabled as model_enabled,
          m.weight as model_weight,
          m.created_at as model_created_at,
          c.id as channel_id_2,
          c.name,
          c.base_url,
          c.api_key,
          c.enabled as channel_enabled,
          c.weight as channel_weight,
          c.timeout,
          c.created_at as channel_created_at
       FROM models m
       JOIN channels c ON c.id = m.channel_id
       WHERE m.alias = ? AND m.enabled = 1 AND c.enabled = 1`,
    )
    .all(alias) as Array<{
    model_id: number;
    alias: string;
    real_model: string;
    channel_id: number;
    model_enabled: number;
    model_weight: number;
    model_created_at: string;
    channel_id_2: number;
    name: string;
    base_url: string;
    api_key: string;
    channel_enabled: number;
    channel_weight: number;
    timeout: number;
    channel_created_at: string;
  }>;

  if (rows.length === 0) return null;

  const weighted = rows.map((r) => ({
    row: r,
    weight: Math.max(1, r.model_weight) * Math.max(1, r.channel_weight),
  }));

  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  let random = Math.random() * totalWeight;

  for (const item of weighted) {
    random -= item.weight;
    if (random <= 0) {
      return {
        model: {
          id: item.row.model_id,
          alias: item.row.alias,
          real_model: item.row.real_model,
          channel_id: item.row.channel_id,
          enabled: item.row.model_enabled,
          weight: item.row.model_weight,
          created_at: item.row.model_created_at,
        },
        channel: {
          id: item.row.channel_id_2,
          name: item.row.name,
          base_url: item.row.base_url,
          api_key: item.row.api_key,
          enabled: item.row.channel_enabled,
          weight: item.row.channel_weight,
          timeout: item.row.timeout,
          created_at: item.row.channel_created_at,
        },
      };
    }
  }

  return {
    model: {
      id: weighted[0].row.model_id,
      alias: weighted[0].row.alias,
      real_model: weighted[0].row.real_model,
      channel_id: weighted[0].row.channel_id,
      enabled: weighted[0].row.model_enabled,
      weight: weighted[0].row.model_weight,
      created_at: weighted[0].row.model_created_at,
    },
    channel: {
      id: weighted[0].row.channel_id_2,
      name: weighted[0].row.name,
      base_url: weighted[0].row.base_url,
      api_key: weighted[0].row.api_key,
      enabled: weighted[0].row.channel_enabled,
      weight: weighted[0].row.channel_weight,
      timeout: weighted[0].row.timeout,
      created_at: weighted[0].row.channel_created_at,
    },
  };
}

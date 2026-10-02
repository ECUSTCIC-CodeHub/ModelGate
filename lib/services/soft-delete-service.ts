import { gatewayDb } from "@/lib/core/db";
import type { TransactionContext } from "@/lib/core/db/adapter";
import { parseAllowedModelAliases, stringifyAllowedModelAliases } from "@/lib/gateway/model-access";

export async function softDeleteUser(userId: string) {
  const isMysql = await gatewayDb.getDriver() === "mysql";
  await gatewayDb.transaction(async (tx) => {
    await tx.execute("UPDATE `keys` SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE user_id = ? AND deleted_at IS NULL", [userId]);
    if (isMysql) {
      await tx.execute("UPDATE users SET username = CONCAT('del', id, HEX(RANDOM_BYTES(3))), enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL", [userId]);
    } else {
      await tx.execute("UPDATE users SET username = 'del' || id || hex(randomblob(3)), enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL", [userId]);
    }
  });
}

export async function softDeleteKey(keyId: string) {
  await gatewayDb.execute("UPDATE `keys` SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL", [keyId]);
}

const CHUNK_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

async function removeAliasesFromAllowedLists(aliases: string[], tx?: TransactionContext): Promise<number> {
  const db = tx ?? gatewayDb;
  const targets = new Set(aliases);
  if (targets.size === 0) return 0;

  const removed = new Set<string>();
  const filterOut = (current: string[]) =>
    current.filter((alias) => {
      if (!targets.has(alias)) return true;
      removed.add(alias);
      return false;
    });

  const groups = await db.query<{ id: number; allowed_model_aliases: string }>(
    "SELECT id, allowed_model_aliases FROM `groups` WHERE deleted_at IS NULL AND allowed_model_aliases IS NOT NULL",
  );
  for (const group of groups) {
    const current = parseAllowedModelAliases(group.allowed_model_aliases);
    const next = filterOut(current);
    if (next.length === current.length) continue;
    await db.execute("UPDATE `groups` SET allowed_model_aliases = ? WHERE id = ?", [stringifyAllowedModelAliases(next), group.id]);
  }

  const users = await db.query<{ id: number; allowed_model_aliases: string }>(
    "SELECT id, allowed_model_aliases FROM users WHERE deleted_at IS NULL AND allowed_model_aliases IS NOT NULL",
  );
  for (const user of users) {
    const current = parseAllowedModelAliases(user.allowed_model_aliases);
    const next = filterOut(current);
    if (next.length === current.length) continue;
    await db.execute("UPDATE users SET allowed_model_aliases = ? WHERE id = ?", [stringifyAllowedModelAliases(next), user.id]);
  }

  return removed.size;
}

export async function softDeleteModels(modelIds: Array<number | string>) {
  const ids = [...new Set(modelIds.map((id) => String(id).trim()))].filter(Boolean);
  if (ids.length === 0) return { deleted: 0, aliasesCleaned: 0 };

  const targetIds: number[] = [];
  for (const batch of chunk(ids, CHUNK_SIZE)) {
    const placeholders = batch.map(() => "?").join(", ");
    const rows = await gatewayDb.query<{ id: number }>(
      `SELECT id FROM models WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      batch,
    );
    for (const row of rows) targetIds.push(row.id);
  }
  if (targetIds.length === 0) return { deleted: 0, aliasesCleaned: 0 };

  const aliases = new Set<string>();
  for (const batch of chunk(targetIds, CHUNK_SIZE)) {
    const placeholders = batch.map(() => "?").join(", ");
    const rows = await gatewayDb.query<{ alias: string }>(
      `SELECT DISTINCT alias FROM models WHERE id IN (${placeholders})`,
      batch,
    );
    for (const row of rows) aliases.add(row.alias);
  }

  let aliasesCleaned = 0;
  await gatewayDb.transaction(async (tx) => {
    for (const batch of chunk(targetIds, CHUNK_SIZE)) {
      const placeholders = batch.map(() => "?").join(", ");
      await tx.execute(
        `UPDATE models SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
        batch,
      );
    }

    const surviving = new Set<string>();
    const aliasList = [...aliases];
    for (const batch of chunk(aliasList, CHUNK_SIZE)) {
      const placeholders = batch.map(() => "?").join(", ");
      const rows = await tx.query<{ alias: string }>(
        `SELECT DISTINCT alias FROM models WHERE enabled = 1 AND deleted_at IS NULL AND alias IN (${placeholders})`,
        batch,
      );
      for (const row of rows) surviving.add(row.alias);
    }

    const cleanTargets = aliasList.filter((alias) => !surviving.has(alias));
    if (cleanTargets.length > 0) aliasesCleaned = await removeAliasesFromAllowedLists(cleanTargets, tx);
  });

  return { deleted: targetIds.length, aliasesCleaned };
}

export async function softDeleteModel(modelId: string) {
  await softDeleteModels([modelId]);
}

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

async function removeAliasFromAllowedLists(alias: string, tx?: TransactionContext) {
  const db = tx ?? gatewayDb;
  const groups = await db.query<{ id: number; allowed_model_aliases: string }>(
    "SELECT id, allowed_model_aliases FROM `groups` WHERE deleted_at IS NULL AND allowed_model_aliases IS NOT NULL",
  );
  for (const group of groups) {
    const current = parseAllowedModelAliases(group.allowed_model_aliases);
    if (!current.includes(alias)) continue;
    const updated = stringifyAllowedModelAliases(current.filter((a) => a !== alias));
    await db.execute("UPDATE `groups` SET allowed_model_aliases = ? WHERE id = ?", [updated, group.id]);
  }

  const users = await db.query<{ id: number; allowed_model_aliases: string }>(
    "SELECT id, allowed_model_aliases FROM users WHERE deleted_at IS NULL AND allowed_model_aliases IS NOT NULL",
  );
  for (const user of users) {
    const current = parseAllowedModelAliases(user.allowed_model_aliases);
    if (!current.includes(alias)) continue;
    const updated = stringifyAllowedModelAliases(current.filter((a) => a !== alias));
    await db.execute("UPDATE users SET allowed_model_aliases = ? WHERE id = ?", [updated, user.id]);
  }
}

export async function softDeleteModel(modelId: string) {
  const model = await gatewayDb.queryOne<{ alias: string }>(
    "SELECT alias FROM models WHERE id = ? AND deleted_at IS NULL",
    [modelId],
  );
  await gatewayDb.transaction(async (tx) => {
    await tx.execute("UPDATE models SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL", [modelId]);
    if (model) {
      const stillExists = await tx.queryOne<{ 1: number }>(
        "SELECT 1 FROM models WHERE alias = ? AND enabled = 1 AND deleted_at IS NULL LIMIT 1",
        [model.alias],
      );
      if (!stillExists) {
        await removeAliasFromAllowedLists(model.alias, tx);
      }
    }
  });
}

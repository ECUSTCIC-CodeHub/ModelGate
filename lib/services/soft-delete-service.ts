import { gatewayDb } from "@/lib/core/db";

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

export async function softDeleteModel(modelId: string) {
  await gatewayDb.execute("UPDATE models SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL", [modelId]);
}

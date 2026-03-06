import { gatewayDb } from "@/lib/db";

export function softDeleteUser(userId: string) {
  const tx = gatewayDb.transaction(() => {
    gatewayDb
      .prepare("UPDATE keys SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE user_id = ? AND deleted_at IS NULL")
      .run(userId);
    gatewayDb
      .prepare("UPDATE users SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL")
      .run(userId);
  });
  tx();
}

export function softDeleteKey(keyId: string) {
  gatewayDb
    .prepare("UPDATE keys SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL")
    .run(keyId);
}

export function softDeleteModel(modelId: string) {
  gatewayDb
    .prepare("UPDATE models SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL")
    .run(modelId);
}

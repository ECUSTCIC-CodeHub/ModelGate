import type { DatabaseAdapter } from "@/lib/core/db/adapter";
import { initializeGatewayDbAsync } from "@/lib/core/db/init";

export type {
  DbChannel,
  DbGroup,
  DbKey,
  DbLog,
  DbModel,
  DbUser,
} from "@/lib/core/db/types";

export type { DatabaseAdapter, TransactionContext, ExecuteResult } from "@/lib/core/db/adapter";

let gatewayDbInstance: DatabaseAdapter | null = null;
let initPromise: Promise<DatabaseAdapter> | null = null;

const getGatewayDb = (): DatabaseAdapter => {
  if (gatewayDbInstance) return gatewayDbInstance;
  if (!initPromise) {
    initPromise = initializeGatewayDbAsync().then((db) => {
      gatewayDbInstance = db;
      return db;
    });
  }
  throw initPromise;
};

export const gatewayDb: DatabaseAdapter = new Proxy({} as DatabaseAdapter, {
  get(_target, prop) {
    const db = getGatewayDb();
    const value = db[prop as keyof DatabaseAdapter];
    return typeof value === "function" ? (value as Function).bind(db) : value;
  },
});

export async function ensureDbReady(): Promise<DatabaseAdapter> {
  if (gatewayDbInstance) return gatewayDbInstance;
  if (!initPromise) {
    initPromise = initializeGatewayDbAsync().then((db) => {
      gatewayDbInstance = db;
      return db;
    });
  }
  return initPromise;
}

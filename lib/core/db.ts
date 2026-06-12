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

const awaitInit = (): Promise<DatabaseAdapter> => {
  if (gatewayDbInstance) return Promise.resolve(gatewayDbInstance);
  if (!initPromise) {
    initPromise = initializeGatewayDbAsync()
      .then((db) => {
        gatewayDbInstance = db;
        return db;
      })
      .catch((err) => {
        initPromise = null;
        throw err;
      });
  }
  return initPromise;
};

const ASYNC_METHODS = new Set(["query", "queryOne", "execute", "exec", "transaction", "ensureColumn", "close", "getDriver"]);
type DatabaseMethod = (...args: unknown[]) => unknown;

function dbValue(db: DatabaseAdapter, prop: string | symbol) {
  const value = db[prop as keyof DatabaseAdapter];
  return typeof value === "function" ? (value as DatabaseMethod).bind(db) : value;
}

export const gatewayDb: DatabaseAdapter = new Proxy({} as DatabaseAdapter, {
  get(_target, prop) {
    // Synchronous read-only access (e.g. driver check) when already initialized
    if (gatewayDbInstance) {
      return dbValue(gatewayDbInstance, prop);
    }
    // Not yet initialized – wrap methods to await init first
    const propName = prop as string;
    if (ASYNC_METHODS.has(propName)) {
      return async (...args: unknown[]) => {
        const db = await awaitInit();
        return (db[propName as keyof DatabaseAdapter] as DatabaseMethod).apply(db, args);
      };
    }
    // For property access (e.g. `driver`), return from a promise-then chain
    // This handles `gatewayDb.driver` by returning a getter that resolves after init.
    // Since `driver` is the only sync property and it's always checked inside async
    // functions, we create a lazy getter via a thenable.
    return awaitInit().then((db) => {
      return dbValue(db, prop);
    });
  },
});

export async function ensureDbReady(): Promise<DatabaseAdapter> {
  return awaitInit();
}

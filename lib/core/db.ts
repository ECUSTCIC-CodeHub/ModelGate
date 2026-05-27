import type BetterSqlite3 from "better-sqlite3";
import { initializeGatewayDb } from "@/lib/core/db/init";

export type {
  DbChannel,
  DbGroup,
  DbKey,
  DbLog,
  DbModel,
  DbUser,
} from "@/lib/core/db/types";

let gatewayDbInstance: BetterSqlite3.Database | null = null;

const getGatewayDb = () => {
  if (!gatewayDbInstance) {
    gatewayDbInstance = initializeGatewayDb();
  }
  return gatewayDbInstance;
};

export const gatewayDb = new Proxy({} as BetterSqlite3.Database, {
  get(_target, prop) {
    const value = getGatewayDb()[prop as keyof BetterSqlite3.Database];
    return typeof value === "function" ? value.bind(getGatewayDb()) : value;
  },
});

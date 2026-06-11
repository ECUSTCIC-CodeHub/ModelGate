export type ExecuteResult = {
  changes: number;
  lastInsertRowid: number;
};

export interface TransactionContext {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;
  exec(sql: string): Promise<void>;
}

export interface DatabaseAdapter {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T>;
  ensureColumn(table: string, column: string, ddl: string): Promise<boolean>;
  close(): Promise<void>;
  readonly driver: "sqlite" | "mysql";
}

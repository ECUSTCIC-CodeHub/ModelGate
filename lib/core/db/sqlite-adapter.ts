import type BetterSqlite3 from "better-sqlite3";
import type { DatabaseAdapter, ExecuteResult, TransactionContext } from "@/lib/core/db/adapter";

function runAsync<T>(fn: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        resolve(fn());
      } catch (err) {
        reject(err);
      }
    });
  });
}

function makeTxContext(db: BetterSqlite3.Database): TransactionContext {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      return runAsync(() => {
        const stmt = db.prepare(sql);
        return (params ? stmt.all(...params) : stmt.all()) as T[];
      });
    },
    async queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined> {
      return runAsync(() => {
        const stmt = db.prepare(sql);
        return (params ? stmt.get(...params) : stmt.get()) as T | undefined;
      });
    },
    async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
      return runAsync(() => {
        const stmt = db.prepare(sql);
        const info = params ? stmt.run(...params) : stmt.run();
        return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
      });
    },
    async exec(sql: string): Promise<void> {
      return runAsync(() => { db.exec(sql); });
    },
  };
}

export class SqliteAdapter implements DatabaseAdapter {
  readonly driver = "sqlite" as const;
  constructor(private db: BetterSqlite3.Database) {}

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return runAsync(() => {
      const stmt = this.db.prepare(sql);
      return (params ? stmt.all(...params) : stmt.all()) as T[];
    });
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined> {
    return runAsync(() => {
      const stmt = this.db.prepare(sql);
      return (params ? stmt.get(...params) : stmt.get()) as T | undefined;
    });
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    return runAsync(() => {
      const stmt = this.db.prepare(sql);
      const info = params ? stmt.run(...params) : stmt.run();
      return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
    });
  }

  async exec(sql: string): Promise<void> {
    return runAsync(() => { this.db.exec(sql); });
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const txFn = this.db.transaction(async () => {
      return fn(makeTxContext(this.db));
    });
    return runAsync(() => txFn()) as Promise<T>;
  }

  async ensureColumn(table: string, column: string, ddl: string): Promise<boolean> {
    return runAsync(() => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((col) => col.name === column)) {
        try {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
          return true;
        } catch (error) {
          if (error instanceof Error && /duplicate column name/i.test(error.message)) {
            return false;
          }
          throw error;
        }
      }
      return false;
    });
  }

  async close(): Promise<void> {
    return runAsync(() => { this.db.close(); });
  }
}

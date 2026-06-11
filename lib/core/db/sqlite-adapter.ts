import type BetterSqlite3 from "better-sqlite3";
import type { DatabaseAdapter, ExecuteResult, TransactionContext } from "@/lib/core/db/adapter";

const STMT_CACHE_MAX = 256;

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

function makeStmtCache(db: BetterSqlite3.Database) {
  const cache = new Map<string, BetterSqlite3.Statement>();
  return (sql: string): BetterSqlite3.Statement => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      if (cache.size >= STMT_CACHE_MAX) {
        const oldest = cache.keys().next().value!;
        cache.delete(oldest);
      }
      cache.set(sql, stmt);
    }
    return stmt;
  };
}

function makeTxContext(db: BetterSqlite3.Database, prepare: (sql: string) => BetterSqlite3.Statement): TransactionContext {
  return {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      return runAsync(() => {
        const stmt = prepare(sql);
        return (params ? stmt.all(...params) : stmt.all()) as T[];
      });
    },
    queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined> {
      return runAsync(() => {
        const stmt = prepare(sql);
        return (params ? stmt.get(...params) : stmt.get()) as T | undefined;
      });
    },
    execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
      return runAsync(() => {
        const stmt = prepare(sql);
        const info = params ? stmt.run(...params) : stmt.run();
        return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
      });
    },
    exec(sql: string): Promise<void> {
      return runAsync(() => { db.exec(sql); });
    },
  };
}

export class SqliteAdapter implements DatabaseAdapter {
  readonly driver = "sqlite" as const;
  async getDriver() { return this.driver; }
  private prepare: (sql: string) => BetterSqlite3.Statement;

  constructor(private db: BetterSqlite3.Database) {
    this.prepare = makeStmtCache(db);
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return runAsync(() => {
      const stmt = this.prepare(sql);
      return (params ? stmt.all(...params) : stmt.all()) as T[];
    });
  }

  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined> {
    return runAsync(() => {
      const stmt = this.prepare(sql);
      return (params ? stmt.get(...params) : stmt.get()) as T | undefined;
    });
  }

  execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    return runAsync(() => {
      const stmt = this.prepare(sql);
      const info = params ? stmt.run(...params) : stmt.run();
      return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
    });
  }

  exec(sql: string): Promise<void> {
    return runAsync(() => { this.db.exec(sql); });
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const txPrepare = makeStmtCache(this.db);
    const txFn = this.db.transaction(() => {
      return fn(makeTxContext(this.db, txPrepare));
    });
    return runAsync(() => txFn());
  }

  ensureColumn(table: string, column: string, ddl: string): Promise<boolean> {
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

  close(): Promise<void> {
    return runAsync(() => { this.db.close(); });
  }
}

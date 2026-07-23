import mysql, { type Pool, type PoolConnection, type RowDataPacket, type ResultSetHeader } from "mysql2/promise";
import type { DatabaseAdapter, ExecuteResult, TransactionContext } from "@/lib/core/db/adapter";

function normalizeParams(params?: unknown[]): unknown[] | undefined {
  if (!params || params.length === 0) return undefined;
  let needsConvert = false;
  for (const p of params) {
    if (typeof p === "boolean") { needsConvert = true; break; }
  }
  if (!needsConvert) return params;
  return params.map((p) => typeof p === "boolean" ? (p ? 1 : 0) : p);
}

function makeTxContext(conn: PoolConnection): TransactionContext {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const p = normalizeParams(params);
      const [rows] = await conn.execute<RowDataPacket[]>(sql, p as never);
      return rows as T[];
    },
    async queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined> {
      const p = normalizeParams(params);
      const [rows] = await conn.execute<RowDataPacket[]>(sql, p as never);
      return (rows[0] as T) ?? undefined;
    },
    async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
      const p = normalizeParams(params);
      const [result] = await conn.execute<ResultSetHeader>(sql, p as never);
      return { changes: result.affectedRows, lastInsertRowid: Number(result.insertId) };
    },
    async exec(sql: string): Promise<void> {
      await conn.query(sql);
    },
  };
}

function stripTextDefaultClause(ddl: string): string {
  // 只在列类型定义部分（DEFAULT 关键字之前）检测大对象类型，
  // 避免 DEFAULT 值字符串里恰好含 text/json 等单词时误判为 TEXT 列而误剥默认值。
  const defaultIdx = ddl.search(/\bDEFAULT\b/i);
  const typePart = defaultIdx === -1 ? ddl : ddl.slice(0, defaultIdx);
  if (/\b(TEXT|BLOB|JSON|GEOMETRY|TINYTEXT|MEDIUMTEXT|LONGTEXT)\b/i.test(typePart)) {
    return ddl
      .replace(/\s+DEFAULT\s+'[^']*'/gi, "")
      .replace(/\s+DEFAULT\s+NULL\b/gi, "");
  }
  return ddl;
}

export class MysqlAdapter implements DatabaseAdapter {
  readonly driver = "mysql" as const;
  async getDriver() { return this.driver; }
  private pool: Pool;

  constructor(config: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    poolSize?: number;
  }) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: config.poolSize ?? 10,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      multipleStatements: true,
      decimalNumbers: true,
      dateStrings: true,
    });
    // mysql2 的 timezone 选项只影响客户端 Date 的转义/解析，不会改服务端会话时区；
    // 这里在每条连接建立时显式 SET，让 CURRENT_TIMESTAMP/NOW()/DEFAULT CURRENT_TIMESTAMP 返回 UTC。
    this.pool.on("connection", (conn) => {
      conn.query("SET time_zone = '+00:00'");
    });
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const p = normalizeParams(params);
    const [rows] = await this.pool.execute<RowDataPacket[]>(sql, p as never);
    return rows as T[];
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined> {
    const p = normalizeParams(params);
    const [rows] = await this.pool.execute<RowDataPacket[]>(sql, p as never);
    return (rows[0] as T) ?? undefined;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    const p = normalizeParams(params);
    const [result] = await this.pool.execute<ResultSetHeader>(sql, p as never);
    return { changes: result.affectedRows, lastInsertRowid: Number(result.insertId) };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(makeTxContext(conn));
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async ensureColumn(table: string, column: string, ddl: string): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    if (rows.length > 0) return false;
    try {
      await this.pool.execute(`ALTER TABLE \`${table}\` ADD COLUMN ${stripTextDefaultClause(ddl)}`);
      return true;
    } catch (error) {
      if (error instanceof Error && /duplicate column name/i.test(error.message)) {
        return false;
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

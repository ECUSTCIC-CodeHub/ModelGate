import mysql, { type Pool, type PoolConnection, type RowDataPacket, type ResultSetHeader } from "mysql2/promise";
import type { DatabaseAdapter, ExecuteResult, TransactionContext } from "@/lib/core/db/adapter";
import { DbPoolExhaustedError } from "@/lib/core/db/errors";

export const DEFAULT_POOL_QUEUE_LIMIT = 200;
export const DEFAULT_POOL_ACQUIRE_TIMEOUT_MS = 5_000;
export const DEFAULT_LOCK_WAIT_TIMEOUT_SECONDS = 5;

// 协议/网络级失败后连接不可复用：mysql2 用 fatal 标记，另有若干错误码表示连接已断。
const FATAL_ERROR_CODES = new Set([
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
  "PROTOCOL_ENQUEUE_AFTER_QUIT",
  "PROTOCOL_CONNECTION_LOST",
  "ECONNRESET",
  "ETIMEDOUT",
  "ER_CLIENT_INTERACTION_TIMEOUT",
]);

function isFatalConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ((err as Error & { fatal?: boolean }).fatal === true) return true;
  const code = (err as Error & { code?: string }).code;
  return typeof code === "string" && FATAL_ERROR_CODES.has(code);
}

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
  private acquireTimeoutMs: number;
  private queueLimit: number;

  constructor(config: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    poolSize?: number;
    queueLimit?: number;
    acquireTimeoutMs?: number;
    lockWaitTimeoutSeconds?: number;
  }) {
    this.acquireTimeoutMs = config.acquireTimeoutMs ?? DEFAULT_POOL_ACQUIRE_TIMEOUT_MS;
    this.queueLimit = config.queueLimit ?? DEFAULT_POOL_QUEUE_LIMIT;
    // 行锁等待上限必须收紧：默认 50s 会让拿不到锁的事务把池连接占住几十秒，
    // 取连接超时只能挡住后续请求，挡不住已经拿到连接的那 10 个。
    const lockWaitCandidate = config.lockWaitTimeoutSeconds ?? DEFAULT_LOCK_WAIT_TIMEOUT_SECONDS;
    const lockWaitTimeout = Number.isFinite(lockWaitCandidate)
      ? Math.min(60, Math.max(1, Math.floor(lockWaitCandidate)))
      : DEFAULT_LOCK_WAIT_TIMEOUT_SECONDS;
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: config.poolSize ?? 10,
      waitForConnections: true,
      // 队列必须有界：热点表行锁会让连接长期无法归还，队列无上限时全站请求会一起无限等待。
      queueLimit: this.queueLimit,
      enableKeepAlive: true,
      multipleStatements: true,
      decimalNumbers: true,
      dateStrings: true,
    });
    // mysql2 的 timezone 选项只影响客户端 Date 的转义/解析，不会改服务端会话时区；
    // 这里在每条连接建立时显式 SET，让 CURRENT_TIMESTAMP/NOW()/DEFAULT CURRENT_TIMESTAMP 返回 UTC。
    this.pool.on("connection", (conn) => {
      // 变量设置失败必须留痕：静默失败会让行锁等待上限停在默认 50s，等于没防护。
      // 拆成两条 SET，时区设置失败不影响锁等待上限生效。
      conn.query("SET SESSION time_zone = '+00:00'", (err: Error | null) => {
        if (err) console.error("[db] 会话时区初始化失败:", err);
      });
      conn.query(`SET SESSION innodb_lock_wait_timeout = ${lockWaitTimeout}`, (err: Error | null) => {
        if (err) console.error("[db] 行锁等待上限初始化失败:", err);
      });
    });
  }

  // 取连接加硬超时：连接池被热点行锁占满时立即失败并释放请求，
  // 而不是让队列无限堆积导致整站无响应。超时后迟到的连接仍然归还，避免泄漏到池外。
  private async acquire(): Promise<PoolConnection> {
    const pending = this.pool.getConnection().catch((err: unknown) => {
      // mysql2 队列满时抛的是英文 Error（code=POOL_ENQUEUELIMIT），
      // 这里归一成容量类错误，便于上层按 503 处理
      const code = (err as { code?: string }).code;
      if (code === "POOL_ENQUEUELIMIT" || (err instanceof Error && /queue limit reached/i.test(err.message))) {
        throw new DbPoolExhaustedError(`数据库连接池排队已满（上限 ${this.queueLimit}），请稍后重试`);
      }
      throw err;
    });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new DbPoolExhaustedError(`等待数据库连接超时（${this.acquireTimeoutMs}ms）`));
      }, this.acquireTimeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([pending, timeout]);
    } catch (err) {
      if (timedOut) {
        void pending.then((conn) => { conn.release(); }).catch(() => {});
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async withConnection<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
    const conn = await this.acquire();
    let fatal = false;
    try {
      return await fn(conn);
    } catch (err) {
      fatal = isFatalConnectionError(err);
      throw err;
    } finally {
      // 连接级致命错误（网络中断等）放回池里只会让下一个请求继续失败，直接销毁让池重建
      if (fatal) conn.destroy();
      else conn.release();
    }
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const p = normalizeParams(params);
    return this.withConnection(async (conn) => {
      const [rows] = await conn.execute<RowDataPacket[]>(sql, p as never);
      return rows as T[];
    });
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined> {
    const p = normalizeParams(params);
    return this.withConnection(async (conn) => {
      const [rows] = await conn.execute<RowDataPacket[]>(sql, p as never);
      return (rows[0] as T) ?? undefined;
    });
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    const p = normalizeParams(params);
    return this.withConnection(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(sql, p as never);
      return { changes: result.affectedRows, lastInsertRowid: Number(result.insertId) };
    });
  }

  async exec(sql: string): Promise<void> {
    await this.withConnection(async (conn) => {
      await conn.query(sql);
    });
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const conn = await this.acquire();
    try {
      await conn.beginTransaction();
      const result = await fn(makeTxContext(conn));
      await conn.commit();
      conn.release();
      return result;
    } catch (err) {
      let reusable = false;
      try {
        await conn.rollback();
        // 回滚成功但连接本身已断（如网络中断）时仍不可复用
        reusable = !isFatalConnectionError(err);
      } catch {
        // 回滚失败说明连接已不可用，销毁而不是放回池里，避免把未结束的事务带进后续请求
        reusable = false;
      }
      if (reusable) conn.release();
      else conn.destroy();
      throw err;
    }
  }

  async ensureColumn(table: string, column: string, ddl: string): Promise<boolean> {
    const rows = await this.query<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    if (rows.length > 0) return false;
    try {
      await this.exec(`ALTER TABLE \`${table}\` ADD COLUMN ${stripTextDefaultClause(ddl)}`);
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

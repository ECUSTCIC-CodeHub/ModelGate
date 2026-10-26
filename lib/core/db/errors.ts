// 数据库容量类错误（连接池排队已满 / 等待空闲连接超时）。
// 独立成类型是为了让调用方能和 SQL 执行失败区分开，按 503 快速失败并允许上层退避重试。
export class DbPoolExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbPoolExhaustedError";
  }
}

export function isDbCapacityError(err: unknown): boolean {
  if (err instanceof DbPoolExhaustedError) return true;
  // Next.js 的打包边界可能让同一模块存在多份实例导致 instanceof 失效，补一层名称判定
  return err instanceof Error && err.name === "DbPoolExhaustedError";
}

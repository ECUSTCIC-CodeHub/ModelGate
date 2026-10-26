// 资源繁忙（锁冲突、抢锁超时）类错误：与 SQL 执行失败区分开，
// 由路由层映射成 503 + retry-after，让客户端退避重试而不是直接报错。
export class BusyError extends Error {
  constructor(message = "操作过于繁忙，请稍后重试") {
    super(message);
    this.name = "BusyError";
  }
}

export function isBusyError(err: unknown): boolean {
  if (err instanceof BusyError) return true;
  // 打包边界可能产生多份模块实例导致 instanceof 失效
  return err instanceof Error && err.name === "BusyError";
}

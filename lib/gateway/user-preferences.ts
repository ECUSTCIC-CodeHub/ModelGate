/**
 * 用户个人偏好的三态合并：-1 继承全局 / 0 强制关闭 / 1 强制开启。
 * 个人未设置（-1 或其他非 0/1 值）时回退到全局开关。
 */
export function resolveTriState(userVal: number | null | undefined, globalEnabled: boolean): boolean {
  if (userVal === 1) return true;
  if (userVal === 0) return false;
  return globalEnabled;
}

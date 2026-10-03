import { getGatewaySettings } from "@/lib/core/settings";

// 50MB 是代码常量而非设置项：设置页只提供开关，前端文案同样硬编码 50MB
export const GATEWAY_MAX_BODY_BYTES = 50 * 1024 * 1024;

// 关闭开关时表示不限制。用 null 而不是 Infinity/Number.MAX_SAFE_INTEGER：
// 前者在 JSON/透传处容易被序列化成 null 以外的形态，后者的 +1 不溢出但会丢精度，
// 统一用「显式上限或 null」避免任何算术依赖。
export async function resolveBodyLimitBytes(): Promise<number | null> {
  try {
    const settings = await getGatewaySettings();
    return settings.request_size_limit_enabled === 1 ? GATEWAY_MAX_BODY_BYTES : null;
  } catch {
    // 设置读取失败按「不限制」处理（fail-open）：这是有意的取向，
    // 避免设置库短暂不可用时把全部正常请求拒之门外
    return null;
  }
}

// Content-Length 只是快速拒绝的预检，缺失或非法时返回 false 交给实际读取去兜底
export function exceedsBodyLimit(contentLength: string | null, limit: number | null): boolean {
  if (limit === null) return false;
  const parsed = Number.parseInt(contentLength || "0", 10);
  if (!Number.isFinite(parsed)) return false;
  return parsed > limit;
}

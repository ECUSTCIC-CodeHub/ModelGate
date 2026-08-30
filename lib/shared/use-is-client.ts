"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};

// 客户端挂载后才返回 true，用于避免 SSR 水合不匹配（如主题模式、窗口属性等）。
export function useIsClient(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

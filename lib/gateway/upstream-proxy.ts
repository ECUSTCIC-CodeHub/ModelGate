import { ProxyAgent, type Dispatcher } from "undici";

type FetchInitWithDispatcher = RequestInit & {
  dispatcher?: Dispatcher;
};

declare global {
  var __upstreamProxyDispatchers__: Map<string, Dispatcher> | undefined;
}

function getProxyDispatcherStore() {
  if (!globalThis.__upstreamProxyDispatchers__) {
    globalThis.__upstreamProxyDispatchers__ = new Map();
  }
  return globalThis.__upstreamProxyDispatchers__;
}

export function normalizeProxyUrl(value: string | null | undefined) {
  return value?.trim() ?? "";
}

export function isValidProxyUrl(value: string | null | undefined) {
  const proxyUrl = normalizeProxyUrl(value);
  if (!proxyUrl) return true;

  try {
    const parsed = new URL(proxyUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function getProxyDispatcher(proxyUrl: string) {
  const store = getProxyDispatcherStore();
  const existing = store.get(proxyUrl);
  if (existing) return existing;

  const dispatcher = new ProxyAgent(proxyUrl);
  store.set(proxyUrl, dispatcher);
  return dispatcher;
}

export function withUpstreamProxy(init: RequestInit, proxyUrl: string | null | undefined): FetchInitWithDispatcher {
  const normalizedProxyUrl = normalizeProxyUrl(proxyUrl);
  if (!normalizedProxyUrl) return init;
  if (!isValidProxyUrl(normalizedProxyUrl)) {
    throw new Error("代理地址仅支持 http:// 或 https://");
  }
  return {
    ...init,
    dispatcher: getProxyDispatcher(normalizedProxyUrl),
  };
}

import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

declare global {
  var __upstreamProxyDispatchers__: Map<string, Dispatcher> | undefined;
  var __upstreamDirectDispatcher__: Dispatcher | undefined;
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

// 未配置代理时显式直连：显式 dispatcher 会覆盖全局 dispatcher 与环境代理设置
function getDirectDispatcher() {
  if (!globalThis.__upstreamDirectDispatcher__) {
    globalThis.__upstreamDirectDispatcher__ = new Agent();
  }
  return globalThis.__upstreamDirectDispatcher__;
}

function resolveUpstreamDispatcher(proxyUrl: string | null | undefined): Dispatcher {
  const normalizedProxyUrl = normalizeProxyUrl(proxyUrl);
  if (!normalizedProxyUrl) return getDirectDispatcher();
  if (!isValidProxyUrl(normalizedProxyUrl)) {
    throw new Error("代理地址仅支持 http:// 或 https://");
  }
  return getProxyDispatcher(normalizedProxyUrl);
}

// undici 与 Node 内置 fetch 的 TS 声明互不兼容，但运行时接收同一套 RequestInit
type DispatcherFetch = (url: string, init?: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>;

const fetchWithDispatcher = undiciFetch as unknown as DispatcherFetch;

// 上游请求统一走 undici 自带的 fetch：Node 内置 fetch 使用自身捆绑的 undici，
// 传入其他大版本的 dispatcher 会在派发时报 InvalidArgumentError，表现为 TypeError: fetch failed
export async function fetchUpstream(url: string, init: RequestInit, proxyUrl: string | null | undefined) {
  return fetchWithDispatcher(url, {
    ...init,
    dispatcher: resolveUpstreamDispatcher(proxyUrl),
  });
}

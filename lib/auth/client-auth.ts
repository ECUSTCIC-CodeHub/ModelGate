"use client";

import type { PeriodQuotaEntry } from "@/lib/gateway/quota";

export type Session = {
  accessToken: string;
  refreshToken: string;
};

export type CachedProfile = {
  id: number;
  username: string;
  role: "admin" | "user";
  rpm: number;
  qps: number;
  tpm: number;
  quota_tokens: number | null;
  quota_requests: number | null;
  used_tokens?: number;
  used_requests?: number;
  period_cycles?: unknown;
  periods?: PeriodQuotaEntry[];
  oidc_issuer?: string | null;
  oidc_subject?: string | null;
};

const KEY = "vlm-session";
const PROFILE_KEY = "vlm-profile";

export function getSession(): Session | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function setSession(session: Session) {
  localStorage.setItem(KEY, JSON.stringify(session));
}

export function getCachedProfile(): CachedProfile | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(PROFILE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedProfile;
  } catch {
    return null;
  }
}

export function setCachedProfile(profile: CachedProfile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

export function clearCachedProfile() {
  localStorage.removeItem(PROFILE_KEY);
}

export function clearSession() {
  localStorage.removeItem(KEY);
  localStorage.removeItem(PROFILE_KEY);
}

export function loginUrlWithNext(): string {
  if (typeof window === "undefined") return "/login";
  const next = window.location.pathname + window.location.search;
  return `/login?next=${encodeURIComponent(next)}`;
}

async function clearExpiredSession() {
  clearSession();
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
}

export type ProfileResolution =
  | { kind: "ok"; profile: CachedProfile }
  | { kind: "unauthorized" }
  | { kind: "retryable" };

// 5xx/429 表示服务端暂时不可用（例如数据库连接池饱和），不能据此认定会话失效：
// 否则一次容量抖动会让所有在线用户被判为未登录，随即集中重登放大事故。
function isRetryableStatus(status: number) {
  return status >= 500 || status === 429;
}

async function resolveProfile(): Promise<ProfileResolution> {
  const cached = getCachedProfile();
  if (cached) return { kind: "ok", profile: cached };

  const response = await authedFetch("/api/dashboard/profile");
  if (!response.ok) {
    return isRetryableStatus(response.status) ? { kind: "retryable" } : { kind: "unauthorized" };
  }
  const data = await response.json().catch(() => null);
  const user = data?.user as CachedProfile | undefined;
  if (!user) return { kind: "unauthorized" };
  setCachedProfile(user);
  return { kind: "ok", profile: user };
}

// 需要区分「未登录」与「服务端暂时不可用」的调用方使用这个版本，
// 后者不应清会话或跳登录页。
export async function resolveAuthProfile(): Promise<ProfileResolution> {
  return resolveProfile();
}

export async function getOrFetchProfile() {
  const result = await resolveProfile();
  return result.kind === "ok" ? result.profile : null;
}

export async function ensureAdmin(router: { push: (url: string) => void }): Promise<CachedProfile | null> {
  const result = await resolveProfile();
  if (result.kind === "retryable") return null;
  if (result.kind !== "ok") {
    clearSession();
    router.push(loginUrlWithNext());
    return null;
  }
  const profile = result.profile;
  if (profile.role !== "admin") {
    router.push("/dashboard/keys");
    return null;
  }
  return profile;
}

export async function ensureLoggedIn(router: { push?: (url: string) => void; replace?: (url: string) => void }): Promise<CachedProfile | null> {
  const result = await resolveProfile();
  if (result.kind === "retryable") return null;
  if (result.kind !== "ok") {
    clearSession();
    (router.replace ?? router.push)?.(loginUrlWithNext());
    return null;
  }
  return result.profile;
}

export async function authedFetch(input: string, init?: RequestInit) {
  const session = getSession();
  const headers = new Headers(init?.headers ?? {});
  if (session?.accessToken) {
    headers.set("authorization", `Bearer ${session.accessToken}`);
  }
  headers.set("content-type", "application/json");

  let response = await fetch(input, { ...init, headers, credentials: "same-origin" });

  if (response.status !== 401) {
    return response;
  }

  const refresh = await fetch("/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(session?.refreshToken ? { refresh_token: session.refreshToken } : {}),
  });

  if (!refresh.ok) {
    // 刷新接口因服务端繁忙（5xx/429）失败时不能注销：服务端此时并没有清 cookie，
    // 客户端抢先注销只会把用户踢回登录页，进而引发集中重登。
    // 这里把 5xx/429 原样返回而不是回吐首次请求的 401，
    // 否则调用方会把它当成「会话失效」而不是「服务端暂时不可用」。
    if (isRetryableStatus(refresh.status)) return refresh;
    await clearExpiredSession();
    return response;
  }

  const refreshData = (await refresh.json()) as {
    access_token: string;
    refresh_token: string;
  };

  if (refreshData?.access_token && refreshData?.refresh_token) {
    setSession({ accessToken: refreshData.access_token, refreshToken: refreshData.refresh_token });
    headers.set("authorization", `Bearer ${refreshData.access_token}`);
  }
  response = await fetch(input, { ...init, headers, credentials: "same-origin" });
  return response;
}
